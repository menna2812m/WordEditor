using Azm.Wopi.Discovery;
using Azm.Wopi.Security;
using Azm.Wopi.Storage;
using Azm.Wopi.Tokens;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Azm.Wopi;

public static class WopiServiceCollectionExtensions
{
    public const string SessionPolicyName = "Azm.Wopi.Session";
    public const string AdminPolicyName = "Azm.Wopi.Admin";
    private const string DiscoveryClientName = "Azm.Wopi.Discovery";

    /// <summary>
    /// Registers the WOPI module. Call before AddControllers()/MapControllers().
    /// Replace the defaults by registering your own IWopiFileStore, IWopiLockStore or IWopiPermissionService afterwards.
    /// </summary>
    public static IServiceCollection AddWopi(this IServiceCollection services, IConfiguration configuration)
    {
        var section = configuration.GetSection(WopiOptions.SectionName);
        services.Configure<WopiOptions>(section);
        var sessionPolicy = section.GetValue<string?>(nameof(WopiOptions.SessionPolicy));
        var adminPolicy = section.GetValue<string?>(nameof(WopiOptions.AdminPolicy));

        services.TryAddSingleton<WopiAccessTokenService>();
        services.AddHttpClient(DiscoveryClientName, c => c.Timeout = TimeSpan.FromSeconds(10));
        services.TryAddSingleton(sp => new WopiDiscoveryService(
            sp.GetRequiredService<IHttpClientFactory>().CreateClient(DiscoveryClientName),
            sp.GetRequiredService<IOptions<WopiOptions>>(),
            sp.GetRequiredService<ILogger<WopiDiscoveryService>>()));
        services.TryAddSingleton<IWopiFileStore, FileSystemWopiFileStore>();
        services.TryAddSingleton<IWopiLockStore, InMemoryWopiLockStore>();
        services.TryAddScoped<IWopiPermissionService, AllowAuthenticatedPermissionService>();

        services.AddAuthorization(o =>
        {
            if (!string.IsNullOrEmpty(sessionPolicy))
                o.AddPolicy(SessionPolicyName, p => p.Combine(o.GetPolicy(sessionPolicy) ?? throw new InvalidOperationException($"Authorization policy '{sessionPolicy}' (Wopi:SessionPolicy) is not registered. Register it before AddWopi().")));
            else
                o.AddPolicy(SessionPolicyName, p => p.RequireAuthenticatedUser());
            if (!string.IsNullOrEmpty(adminPolicy))
                o.AddPolicy(AdminPolicyName, p => p.Combine(o.GetPolicy(adminPolicy) ?? throw new InvalidOperationException($"Authorization policy '{adminPolicy}' (Wopi:AdminPolicy) is not registered. Register it before AddWopi().")));
            else
                o.AddPolicy(AdminPolicyName, p => p.RequireAuthenticatedUser());
        });

        // public API for external applications (/api/v1) + signed webhooks
        services.AddAuthentication().AddScheme<AuthenticationSchemeOptions, PublicApi.ApiKeyAuthenticationHandler>(PublicApi.ApiKeyAuthenticationHandler.SchemeName, null);
        services.AddRateLimiter(PublicApi.ApiRateLimiting.AddPolicy);
        services.AddHttpClient("Azm.Wopi.Webhooks", c => c.Timeout = TimeSpan.FromSeconds(15));
        services.TryAddSingleton<Events.IWebhookOutbox, Events.FileWebhookOutbox>();
        services.TryAddSingleton<Events.WebhookDispatcher>();
        services.TryAddSingleton<Events.IWopiEvents>(sp => sp.GetRequiredService<Events.WebhookDispatcher>());
        services.AddHostedService(sp => sp.GetRequiredService<Events.WebhookDispatcher>());

        services.AddControllers().AddApplicationPart(typeof(WopiServiceCollectionExtensions).Assembly);
        return services;
    }
}
