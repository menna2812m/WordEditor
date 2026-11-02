using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Azm.Wopi.PublicApi;

/// <summary>
/// Per-API-key rate limiting for /api/v1 (token bucket: the per-minute allowance refills continuously, bursts up to the same size).
/// Requests without a known key share one small bucket per caller IP, so guessing keys is throttled too.
/// </summary>
public static class ApiRateLimiting
{
    public const string PolicyName = "Azm.Wopi.PublicApi";

    internal static void AddPolicy(RateLimiterOptions o)
    {
        o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
        o.OnRejected = async (ctx, ct) =>
        {
            var retry = ctx.Lease.TryGetMetadata(MetadataName.RetryAfter, out var ra) ? (int)Math.Ceiling(ra.TotalSeconds) : 60;
            ctx.HttpContext.Response.Headers.RetryAfter = retry.ToString();
            ctx.HttpContext.Response.ContentType = "application/problem+json";
            await ctx.HttpContext.Response.WriteAsync($"{{\"type\":\"about:blank\",\"title\":\"Too many requests\",\"detail\":\"Retry after {retry} seconds.\",\"status\":429}}", ct);
        };
        o.AddPolicy(PolicyName, http =>
        {
            var opt = http.RequestServices.GetRequiredService<IOptionsMonitor<WopiOptions>>().CurrentValue;
            var key = ExtractKey(http.Request);
            var client = key is null ? null : opt.ApiClients.FirstOrDefault(c => string.Equals(c.KeySha256, WopiApiKeys.Hash(key), StringComparison.OrdinalIgnoreCase));
            if (client is null)   // unknown or missing key: small per-IP bucket
                return RateLimitPartition.GetTokenBucketLimiter("anon:" + (http.Connection.RemoteIpAddress?.ToString() ?? "?"), _ => Bucket(30));
            var perMinute = client.RequestsPerMinute > 0 ? client.RequestsPerMinute : opt.ApiRequestsPerMinute;
            return perMinute <= 0
                ? RateLimitPartition.GetNoLimiter("client:" + client.Id)
                : RateLimitPartition.GetTokenBucketLimiter($"client:{client.Id}:{perMinute}", _ => Bucket(perMinute));
        });
    }

    private static TokenBucketRateLimiterOptions Bucket(int perMinute) => new()
    {
        TokenLimit = perMinute, TokensPerPeriod = Math.Max(1, perMinute / 60), ReplenishmentPeriod = TimeSpan.FromSeconds(Math.Max(1, 60 / Math.Max(1, perMinute))),
        QueueLimit = 0, AutoReplenishment = true
    };

    private static string? ExtractKey(HttpRequest r)
    {
        var auth = r.Headers.Authorization.ToString();
        if (auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return auth[7..].Trim();
        var k = r.Headers["X-Api-Key"].ToString();
        return string.IsNullOrEmpty(k) ? null : k;
    }
}

public static class WopiApplicationBuilderExtensions
{
    /// <summary>Adds the WOPI module's middleware (rate limiting for the public API). Call after UseAuthentication/UseAuthorization, before MapControllers.</summary>
    public static IApplicationBuilder UseWopi(this IApplicationBuilder app) => app.UseRateLimiter();
}
