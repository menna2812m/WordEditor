using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Azm.Wopi.Proof;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Azm.Wopi.Discovery;

public sealed record WopiAction(string App, string Name, string Ext, string UrlSrc);
public sealed record WopiDiscovery(IReadOnlyList<WopiAction> Actions, RSA? ProofKey, RSA? OldProofKey);

/// <summary>Fetches and caches the editor's /hosting/discovery document.</summary>
public sealed partial class WopiDiscoveryService
{
    private readonly HttpClient _http;
    private readonly WopiOptions _opt;
    private readonly ILogger<WopiDiscoveryService> _log;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private WopiDiscovery? _cache;
    private DateTimeOffset _fetchedAt;
    private static readonly TimeSpan Refresh = TimeSpan.FromHours(12);

    public WopiDiscoveryService(HttpClient http, IOptions<WopiOptions> options, ILogger<WopiDiscoveryService> log)
    { _http = http; _opt = options.Value; _log = log; }

    public bool IsLoaded => _cache is not null;

    public async Task<WopiDiscovery> GetAsync(bool forceRefresh = false, CancellationToken ct = default)
    {
        if (!forceRefresh && _cache is not null && DateTimeOffset.UtcNow - _fetchedAt < Refresh) return _cache;
        await _gate.WaitAsync(ct);
        try
        {
            if (!forceRefresh && _cache is not null && DateTimeOffset.UtcNow - _fetchedAt < Refresh) return _cache;
            var xml = await _http.GetStringAsync(_opt.DiscoveryUrl, ct);
            _cache = Parse(xml); _fetchedAt = DateTimeOffset.UtcNow;
            _log.LogInformation("WOPI discovery loaded: {Actions} actions, proof key {HasKey}", _cache.Actions.Count, _cache.ProofKey is not null);
            return _cache;
        }
        finally { _gate.Release(); }
    }

    public static WopiDiscovery Parse(string xml)
    {
        var doc = XDocument.Parse(xml);
        var actions = doc.Descendants().Where(e => e.Name.LocalName == "app")
            .SelectMany(app => app.Elements().Where(e => e.Name.LocalName == "action").Select(a => new WopiAction(
                (string?)app.Attribute("name") ?? "", (string?)a.Attribute("name") ?? "", ((string?)a.Attribute("ext") ?? "").ToLowerInvariant(), (string?)a.Attribute("urlsrc") ?? "")))
            .ToList();
        var pk = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "proof-key");
        RSA? cur = null, old = null;
        if (pk is not null)
        {
            cur = WopiProofValidator.KeyFromModulusExponent((string?)pk.Attribute("modulus"), (string?)pk.Attribute("exponent"));
            old = WopiProofValidator.KeyFromModulusExponent((string?)pk.Attribute("oldmodulus"), (string?)pk.Attribute("oldexponent"));
        }
        return new WopiDiscovery(actions, cur, old);
    }

    /// <summary>Strips Microsoft-style &lt;placeholder&amp;&gt; groups and leaves the URL ready for "WOPISrc=" to be appended.</summary>
    public static string CleanUrlSrc(string urlsrc)
    {
        var u = Placeholder().Replace(urlsrc, "");
        if (!u.Contains('?')) u += "?";
        else if (!u.EndsWith('?') && !u.EndsWith('&')) u += "&";
        return u;
    }

    public async Task<(string Action, string Url)?> GetActionUrlAsync(string extension, IEnumerable<string> preferred, CancellationToken ct = default)
    {
        var d = await GetAsync(false, ct);
        extension = extension.TrimStart('.').ToLowerInvariant();
        foreach (var name in preferred)
        {
            var a = d.Actions.FirstOrDefault(x => x.Ext == extension && x.Name == name);
            if (a is null) continue;
            var url = CleanUrlSrc(a.UrlSrc);
            if (!string.IsNullOrEmpty(_opt.ClientPublicUrl))
            {
                var u = new Uri(url);
                url = _opt.ClientPublicUrl.TrimEnd('/') + u.PathAndQuery;
            }
            return (name, url);
        }
        return null;
    }

    [GeneratedRegex("<[^>]*>")]
    private static partial Regex Placeholder();
}
