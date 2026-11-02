using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace Azm.Wopi.Events;

/// <summary>
/// Operator endpoints for webhook deliveries: see what is waiting or failed, and redeliver failed ones.
/// Disabled (404) unless Wopi:AdminPolicy names an authorization policy of the platform, e.g. "PlatformAdmins".
/// </summary>
[ApiController]
[Route("api/wopi/webhooks")]
[Authorize(Policy = WopiServiceCollectionExtensions.AdminPolicyName)]
[ApiExplorerSettings(IgnoreApi = true)]
public sealed class WebhookAdminController(IWebhookOutbox outbox, WebhookDispatcher dispatcher, IOptionsMonitor<WopiOptions> options) : ControllerBase
{
    private bool Enabled => !string.IsNullOrEmpty(options.CurrentValue.AdminPolicy);

    /// <summary>GET /api/wopi/webhooks — pending count and dead letters.</summary>
    [HttpGet]
    public IActionResult Status()
    {
        if (!Enabled) return NotFound();
        var dead = outbox.DeadLetters();
        return Ok(new
        {
            pending = outbox.CountPending(),
            deadLetters = dead.Select(d => new { d.Id, d.EventId, d.ClientId, d.EventType, d.Attempts, d.LastError, d.CreatedAt })
        });
    }

    /// <summary>POST /api/wopi/webhooks/dead/{id}/redeliver — queue a failed delivery again.</summary>
    [HttpPost("dead/{id}/redeliver")]
    public IActionResult Redeliver(string id)
    {
        if (!Enabled) return NotFound();
        if (!outbox.Redeliver(id)) return NotFound(new ProblemDetails { Title = "No dead-lettered delivery with this id" });
        dispatcher.Nudge();
        return Accepted();
    }
}
