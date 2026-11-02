using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Azm.Wopi.Tokens;

public sealed record WopiAccessToken(string FileId, string UserId, string UserName, WopiMode Mode, DateTimeOffset ExpiresAt, string? PostMessageOrigin = null)
{
    public bool CanWrite => WopiModes.Writes(Mode);
}

/// <summary>Self-contained signed tokens: base64url(json).base64url(HMAC-SHA256). The editor treats them as opaque.</summary>
public sealed class WopiAccessTokenService
{
    private readonly byte[] _key;

    public WopiAccessTokenService(IOptions<WopiOptions> options, ILogger<WopiAccessTokenService> logger)
    {
        var secret = options.Value.TokenSecret;
        if (string.IsNullOrEmpty(secret) || secret.Length < 32)
        {
            logger.LogWarning("Wopi:TokenSecret is missing or shorter than 32 characters; using a random key. Open editors will fail after a restart and multiple API instances will not accept each other's tokens.");
            _key = RandomNumberGenerator.GetBytes(32);
        }
        else _key = Encoding.UTF8.GetBytes(secret);
    }

    private sealed record Payload(string f, string u, string n, string m, long exp, string j, string? o = null);

    public (string Token, long TtlUnixMs) Issue(string fileId, string userId, string userName, WopiMode mode, TimeSpan lifetime, string? postMessageOrigin = null)
    {
        var exp = DateTimeOffset.UtcNow.Add(lifetime).ToUnixTimeMilliseconds();
        var json = JsonSerializer.SerializeToUtf8Bytes(new Payload(fileId, userId, userName, WopiModes.Name(mode), exp, Convert.ToHexString(RandomNumberGenerator.GetBytes(6)), postMessageOrigin));
        var payload = WebEncoders.Base64UrlEncode(json);
        return (payload + "." + Sign(payload), exp);
    }

    public WopiAccessToken? Validate(string? token)
    {
        if (string.IsNullOrEmpty(token)) return null;
        var dot = token.IndexOf('.');
        if (dot <= 0 || dot == token.Length - 1) return null;
        var payload = token[..dot];
        var sig = Encoding.ASCII.GetBytes(token[(dot + 1)..]);
        var expected = Encoding.ASCII.GetBytes(Sign(payload));
        if (!CryptographicOperations.FixedTimeEquals(sig, expected)) return null;
        try
        {
            var p = JsonSerializer.Deserialize<Payload>(WebEncoders.Base64UrlDecode(payload));
            if (p is null || p.exp < DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) return null;
            if (!WopiModes.TryParse(p.m, out var mode)) return null;
            return new WopiAccessToken(p.f, p.u, p.n, mode, DateTimeOffset.FromUnixTimeMilliseconds(p.exp), p.o);
        }
        catch { return null; }
    }

    /// <summary>Signs any small JSON object for a purpose (e.g. "embed"). Used for stateless, short-lived links.</summary>
    public string Protect<T>(string purpose, T value)
    {
        var payload = WebEncoders.Base64UrlEncode(JsonSerializer.SerializeToUtf8Bytes(value));
        return payload + "." + Sign(purpose + "|" + payload);
    }

    public T? Unprotect<T>(string purpose, string? value) where T : class
    {
        if (string.IsNullOrEmpty(value)) return null;
        var dot = value.IndexOf('.');
        if (dot <= 0 || dot == value.Length - 1) return null;
        var payload = value[..dot];
        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(value[(dot + 1)..]), Encoding.ASCII.GetBytes(Sign(purpose + "|" + payload)))) return null;
        try { return JsonSerializer.Deserialize<T>(WebEncoders.Base64UrlDecode(payload)); } catch { return null; }
    }

    private string Sign(string payload)
    {
        using var h = new HMACSHA256(_key);
        return WebEncoders.Base64UrlEncode(h.ComputeHash(Encoding.ASCII.GetBytes(payload)));
    }
}
