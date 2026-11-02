// Minimal API showing how to plug Azm.Wopi into an existing ASP.NET Core backend.
// In your platform you only need the lines marked [WOPI]; keep your own authentication.
using System.Security.Claims;
using System.Text.Encodings.Web;
using Azm.Wopi;
using Azm.Wopi.Controllers;
using Azm.Wopi.PublicApi;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);

// ---- Authentication -----------------------------------------------------------------------
// Your platform already has this (JWT bearer from your identity provider). Example:
//   builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
//       .AddJwtBearer(o => { o.Authority = "https://login.example.com"; o.Audience = "platform-api"; });
// The sample uses a development-only header scheme so it runs without an identity provider.
builder.Services.AddAuthentication(DevHeaderAuth.SchemeName)
    .AddScheme<AuthenticationSchemeOptions, DevHeaderAuth>(DevHeaderAuth.SchemeName, null);
builder.Services.AddAuthorization(o =>
    // Example operator policy for /api/wopi/webhooks (set Wopi:AdminPolicy=PlatformAdmins). Use your real admin role.
    o.AddPolicy("PlatformAdmins", p => p.RequireAuthenticatedUser().RequireClaim("name", "Admin")));

// ---- CORS for the Angular app (only /api/* is called by the browser) -----------------------
var origins = builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? ["http://localhost:4200"];
builder.Services.AddCors(o => o.AddPolicy("spa", p => p.WithOrigins(origins).AllowAnyHeader().AllowAnyMethod().AllowCredentials()));

builder.Services.AddWopi(builder.Configuration);   // [WOPI] registers storage, permissions, events, public API
// The browser-based ContractsEditor replaces the WOPI editor server (Collabora), so the endpoints only an
// editor server calls are switched off: /wopi/files/*, /api/wopi/sessions|status and /embed/*.
builder.Services.AddControllers().ConfigureApplicationPartManager(m => m.FeatureProviders.Add(new WithoutEditorServerControllers()));

var app = builder.Build();
app.UseCors("spa");
app.UseAuthentication();
app.UseAuthorization();
app.UseWopi();                                      // [WOPI] rate limiting for the public API
app.MapControllers();                               // /api/documents/* (sample host), /api/v1/*, /api/wopi/webhooks
app.MapGet("/healthz", () => Results.Ok(new { ok = true }));
app.Run();

/// <summary>Removes the Azm.Wopi controllers that exist only for a WOPI editor server.</summary>
public sealed class WithoutEditorServerControllers : IApplicationFeatureProvider<ControllerFeature>
{
    private static readonly Type[] Removed = [typeof(WopiController), typeof(WopiSessionsController), typeof(EmbedController)];

    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature)
    {
        foreach (var c in feature.Controllers.Where(c => Removed.Contains(c.AsType())).ToList()) feature.Controllers.Remove(c);
    }
}

/// <summary>
/// DEVELOPMENT ONLY. Signs the caller in as the name in the X-Dev-User header (or ?dev_user=).
/// Replace with your real authentication before deploying anywhere shared.
/// </summary>
public sealed class DevHeaderAuth(IOptionsMonitor<AuthenticationSchemeOptions> o, ILoggerFactory l, UrlEncoder e, IHostEnvironment env)
    : AuthenticationHandler<AuthenticationSchemeOptions>(o, l, e)
{
    public const string SchemeName = "DevHeader";
    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!env.IsDevelopment()) return Task.FromResult(AuthenticateResult.Fail("Development authentication is disabled outside Development."));
        var name = Request.Headers["X-Dev-User"].ToString();
        if (string.IsNullOrWhiteSpace(name)) name = Request.Query["dev_user"].ToString();
        if (string.IsNullOrWhiteSpace(name)) return Task.FromResult(AuthenticateResult.NoResult());
        var id = new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, name.Trim().ToLowerInvariant().Replace(' ', '.')), new Claim("name", name.Trim())], SchemeName);
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(id), SchemeName)));
    }
}
