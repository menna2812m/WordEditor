using Azm.Wopi.Discovery;
using Azm.Wopi.Security;
using Azm.Wopi.Storage;
using Azm.Wopi.Tokens;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Azm.Wopi.Controllers;

public sealed record WopiSessionResponse(
    string FileId, string FileName, string Mode, string[] AllowedModes,
    string ActionUrl, string AccessToken, long AccessTokenTtl, string EditorOrigin);

/// <summary>
/// Called by the Angular app (with the user's normal JWT / cookie) to open a document.
/// Returns everything the browser needs to load the editor in an iframe.
/// </summary>
[ApiController]
[Route("api/wopi")]
[Authorize(Policy = WopiServiceCollectionExtensions.SessionPolicyName)]
public sealed class WopiSessionsController : ControllerBase
{
    private readonly WopiOptions _opt;
    private readonly IWopiFileStore _files;
    private readonly IWopiPermissionService _perms;
    private readonly WopiAccessTokenService _tokens;
    private readonly WopiDiscoveryService _discovery;
    private readonly ILogger<WopiSessionsController> _log;

    public WopiSessionsController(IOptions<WopiOptions> opt, IWopiFileStore files, IWopiPermissionService perms, WopiAccessTokenService tokens, WopiDiscoveryService discovery, ILogger<WopiSessionsController> log)
    { _opt = opt.Value; _files = files; _perms = perms; _tokens = tokens; _discovery = discovery; _log = log; }

    /// <summary>POST /api/wopi/sessions/{fileId}?mode=edit|comment|suggest|approve|view (omit mode for the richest allowed)</summary>
    [HttpPost("sessions/{fileId}")]
    public async Task<ActionResult<WopiSessionResponse>> Create(string fileId, [FromQuery] string? mode = null, CancellationToken ct = default)
    {
        var f = await _files.GetAsync(fileId, ct);
        if (f is null) return NotFound(new ProblemDetails { Title = "Document not found" });

        var rights = await _perms.GetRightsAsync(User, f, ct);
        if (rights == WopiRights.None) return Forbid();
        WopiMode requested;
        if (string.IsNullOrEmpty(mode)) requested = WopiModes.Default(rights);
        else if (!WopiModes.TryParse(mode, out requested)) return BadRequest(new ProblemDetails { Title = "Unknown mode", Detail = "Use edit, comment, suggest, approve or view." });
        if (!WopiModes.Allows(rights, requested))
            return StatusCode(403, new ProblemDetails { Title = $"You cannot open this document in {WopiModes.Name(requested)} mode" });
        var allowed = Enum.GetValues<WopiMode>().Where(m => WopiModes.Allows(rights, m)).Select(WopiModes.Name).ToArray();
        (string Action, string Url)? action;
        try { action = await _discovery.GetActionUrlAsync(Path.GetExtension(f.Name), WopiModes.Actions(requested), ct); }
        catch (Exception e)
        {
            _log.LogError(e, "WOPI editor discovery failed");
            return StatusCode(503, new ProblemDetails { Title = "The document editor is not reachable", Detail = e.Message });
        }
        if (action is null) return StatusCode(415, new ProblemDetails { Title = $"The editor cannot open {Path.GetExtension(f.Name)} files" });

        var effective = WopiModes.ForAction(action.Value.Action, requested, rights);
        var userId = WopiUser.Id(User);
        var (token, ttl) = _tokens.Issue(f.Id, userId, WopiUser.DisplayName(User), effective, TimeSpan.FromHours(_opt.TokenLifetimeHours));
        var wopiSrc = $"{_opt.WopiSrcBase.TrimEnd('/')}/wopi/files/{f.Id}";
        var actionUrl = action.Value.Url + "WOPISrc=" + Uri.EscapeDataString(wopiSrc);
        var editorOrigin = new Uri(action.Value.Url).GetLeftPart(UriPartial.Authority);

        _log.LogInformation("WOPI session file={FileId} user={UserId} mode={Mode}", f.Id, userId, WopiModes.Name(effective));
        return new WopiSessionResponse(f.Id, f.Name, WopiModes.Name(effective), allowed, actionUrl, token, ttl, editorOrigin);
    }

    /// <summary>GET /api/wopi/status — whether the editor is reachable, for health dashboards.</summary>
    [HttpGet("status")]
    public async Task<IActionResult> Status(CancellationToken ct)
    {
        try { var d = await _discovery.GetAsync(false, ct); return Ok(new { editor = "reachable", actions = d.Actions.Count, proofKey = d.ProofKey is not null }); }
        catch (Exception e) { return StatusCode(503, new { editor = "unreachable", error = e.Message }); }
    }
}
