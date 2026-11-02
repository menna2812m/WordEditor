using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Azm.Wopi.PublicApi;

/// <summary>Scopes an API client can be granted.</summary>
public static class ApiScopes
{
    public const string DocumentsRead = "documents.read";
    public const string DocumentsWrite = "documents.write";
    public const string SessionsCreate = "sessions.create";
    public const string ReviewRead = "review.read";
    public const string ReviewWrite = "review.write";
    public static readonly string[] All = [DocumentsRead, DocumentsWrite, SessionsCreate, ReviewRead, ReviewWrite];
}

/// <summary>Creates and hashes API keys. Give the key to the external application once; store only the hash in configuration.</summary>
public static class WopiApiKeys
{
    public static (string Key, string Sha256) Create(string prefix = "ce_live_")
    {
        var key = prefix + Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).Replace('+', '-').Replace('/', '_').TrimEnd('=');
        return (key, Hash(key));
    }
    public static string Hash(string key) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant();
}

/// <summary>Authenticates external applications by API key: "Authorization: Bearer ce_live_..." or "X-Api-Key: ce_live_...".</summary>
public sealed class ApiKeyAuthenticationHandler(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder, IOptionsMonitor<WopiOptions> wopi)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "ContractsEditorApiKey";
    public const string ClientIdClaim = "ce_client";
    public const string ScopeClaim = "scope";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        string? key = null;
        var auth = Request.Headers.Authorization.ToString();
        if (auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) key = auth[7..].Trim();
        if (string.IsNullOrEmpty(key)) key = Request.Headers["X-Api-Key"].ToString();
        if (string.IsNullOrEmpty(key)) return Task.FromResult(AuthenticateResult.NoResult());

        var hash = Encoding.ASCII.GetBytes(WopiApiKeys.Hash(key));
        var client = wopi.CurrentValue.ApiClients.FirstOrDefault(c =>
            !string.IsNullOrEmpty(c.KeySha256) && CryptographicOperations.FixedTimeEquals(hash, Encoding.ASCII.GetBytes(c.KeySha256.ToLowerInvariant())));
        if (client is null) return Task.FromResult(AuthenticateResult.Fail("Unknown API key"));

        var claims = new List<Claim> { new(ClientIdClaim, client.Id), new(ClaimTypes.Name, client.Name.Length > 0 ? client.Name : client.Id) };
        claims.AddRange(client.Scopes.Select(s => new Claim(ScopeClaim, s)));
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, SchemeName));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(principal, SchemeName)));
    }

    protected override async Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = 401;
        Response.ContentType = "application/problem+json";
        await Response.WriteAsync("{\"type\":\"about:blank\",\"title\":\"A valid API key is required\",\"status\":401}");
    }

    protected override async Task HandleForbiddenAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = 403;
        Response.ContentType = "application/problem+json";
        await Response.WriteAsync("{\"type\":\"about:blank\",\"title\":\"This API key does not have the required scope\",\"status\":403}");
    }
}
