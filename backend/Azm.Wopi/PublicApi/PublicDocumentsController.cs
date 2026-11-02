using System.Security.Claims;
using Azm.Wopi.Events;
using Azm.Wopi.Review;
using Azm.Wopi.Security;
using Azm.Wopi.Storage;
using Azm.Wopi.Tokens;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Azm.Wopi.PublicApi;

public sealed record ApiDocument(string Id, string Name, long Size, int Version, string Sha256, DateTimeOffset Modified, string ModifiedBy, string OwnerId, bool OpenInEditor);
public sealed record ApiVersion(int Version, DateTimeOffset SavedAt, string SavedBy, long Size);
public sealed record ApiUser(string Id, string Name);
public sealed record ApiSessionRequest(string? Mode, ApiUser? User, string? Lang, string? ParentOrigin);
public sealed record ApiSession(string DocumentId, string Mode, string[] AllowedModes, string EmbedUrl, DateTimeOffset ExpiresAt);
public sealed record ApiRename(string Name);
public sealed record ApiDecision(string Decision, int Count, int Version);
public sealed record ApiPage<T>(IReadOnlyList<T> Items, int Total, int Skip, int Take);

/// <summary>Embed link payload (signed, short-lived).</summary>
/// <param name="r">The user's rights when the link was made (WopiRights), so the embed page can pick the right mode for file types
/// the editor only opens for commenting (PDF). Missing in links made by older versions.</param>
public sealed record EmbedTicket(string f, string u, string n, string m, string? l, string c, string o, long exp, int? r = null);

/// <summary>
/// Public REST API for external applications: /api/v1. Authenticated by API key (scopes per client).
/// The acting end user is passed in X-User-Id / X-User-Name (writes) or in the session request body.
/// </summary>
[ApiController]
[Route("api/v1/documents")]
[Authorize(AuthenticationSchemes = ApiKeyAuthenticationHandler.SchemeName)]
[EnableRateLimiting(ApiRateLimiting.PolicyName)]
public sealed class PublicDocumentsController(
    IOptionsMonitor<WopiOptions> options, IWopiFileStore files, IWopiLockStore locks, IWopiPermissionService perms,
    WopiAccessTokenService tokens, IWopiEvents events, ILogger<PublicDocumentsController> log) : ControllerBase
{
    private WopiOptions Opt => options.CurrentValue;
    private string ClientId => User.FindFirstValue(ApiKeyAuthenticationHandler.ClientIdClaim) ?? "";
    private WopiApiClientOptions Client => Opt.ApiClients.First(c => c.Id == ClientId);
    private bool Has(string scope) => User.HasClaim(ApiKeyAuthenticationHandler.ScopeClaim, scope);
    private ObjectResult Problem(int status, string title, string? detail = null) => StatusCode(status, new ProblemDetails { Status = status, Title = title, Detail = detail });
    private IActionResult? Need(string scope) => Has(scope) ? null : Problem(403, $"This API key needs the '{scope}' scope");
    private string Actor()
    {
        var name = Header("X-User-Name");
        var who = string.IsNullOrWhiteSpace(name) ? Header("X-User-Id") : name;
        return string.IsNullOrWhiteSpace(who) ? $"{Client.Name} (API)" : $"{who.Trim()} via {(Client.Name.Length > 0 ? Client.Name : Client.Id)}";
    }
    /// <summary>Header values are ASCII; non-ASCII names arrive percent-encoded.</summary>
    private string Header(string n) { var v = Request.Headers[n].ToString(); try { return v.Contains('%') ? Uri.UnescapeDataString(v) : v; } catch { return v; } }
    private async Task<ApiDocument> Dto(WopiFile f, CancellationToken ct) =>
        new(f.Id, f.Name, f.Size, f.Version, f.Sha256, f.Modified, f.ModifiedBy, f.OwnerId, await locks.GetAsync(f.Id, ct) is not null);
    private void Raise(string type, WopiFile f, Dictionary<string, object?>? extra = null)
    {
        var d = new Dictionary<string, object?> { ["documentId"] = f.Id, ["name"] = f.Name, ["version"] = f.Version, ["by"] = f.ModifiedBy, ["source"] = "api:" + ClientId };
        if (extra is not null) foreach (var kv in extra) d[kv.Key] = kv.Value;
        events.Publish(type, d);
    }
    private static async Task<byte[]> ReadAll(Stream s, long max, CancellationToken ct)
    {
        using var ms = new MemoryStream(); var buf = new byte[81920]; int n;
        while ((n = await s.ReadAsync(buf, ct)) > 0) { if (ms.Length + n > max) throw new InvalidDataException("too large"); ms.Write(buf, 0, n); }
        return ms.ToArray();
    }

    /// <summary>GET /api/v1/documents?skip=0&amp;take=50&amp;q=name</summary>
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] int skip = 0, [FromQuery] int take = 50, [FromQuery] string? q = null, CancellationToken ct = default)
    {
        if (Need(ApiScopes.DocumentsRead) is { } e) return e;
        take = Math.Clamp(take, 1, 200); skip = Math.Max(0, skip);
        var all = (await files.ListAsync(ct)).Where(f => string.IsNullOrEmpty(q) || f.Name.Contains(q, StringComparison.OrdinalIgnoreCase)).ToList();
        var items = new List<ApiDocument>();
        foreach (var f in all.Skip(skip).Take(take)) items.Add(await Dto(f, ct));
        return Ok(new ApiPage<ApiDocument>(items, all.Count, skip, take));
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> Get(string id, CancellationToken ct)
    {
        if (Need(ApiScopes.DocumentsRead) is { } e) return e;
        var f = await files.GetAsync(id, ct);
        return f is null ? Problem(404, "Document not found") : Ok(await Dto(f, ct));
    }

    /// <summary>POST /api/v1/documents — multipart form field "file", or a raw body with ?name=Contract.docx</summary>
    [HttpPost]
    [DisableRequestSizeLimit]
    public async Task<IActionResult> Create([FromQuery] string? name, CancellationToken ct)
    {
        if (Need(ApiScopes.DocumentsWrite) is { } e) return e;
        byte[] bytes;
        try
        {
            if (Request.HasFormContentType)
            {
                var form = await Request.ReadFormAsync(ct);
                var file = form.Files.GetFile("file") ?? form.Files.FirstOrDefault();
                if (file is null) return Problem(400, "Send the document in a form field named 'file'");
                name ??= file.FileName;
                await using var s = file.OpenReadStream(); bytes = await ReadAll(s, Opt.MaxFileBytes, ct);
            }
            else bytes = await ReadAll(Request.Body, Opt.MaxFileBytes, ct);
        }
        catch (InvalidDataException) { return Problem(413, "The document is too large"); }
        if (bytes.Length == 0) return Problem(400, "The document is empty");
        if (string.IsNullOrWhiteSpace(name)) return Problem(400, "Give the document a name (?name=Contract.docx)");
        var owner = Header("X-User-Id");
        var f = await files.CreateAsync(name, bytes, string.IsNullOrEmpty(owner) ? "api:" + ClientId : owner, Actor(), ct);
        log.LogInformation("API create file={FileId} client={Client}", f.Id, ClientId);
        Raise(WopiEventTypes.DocumentCreated, f);
        return Created($"/api/v1/documents/{f.Id}", await Dto(f, ct));
    }

    /// <summary>POST /api/v1/documents/blank?name=Contract.docx — an empty Word document.</summary>
    [HttpPost("blank")]
    public async Task<IActionResult> CreateBlank([FromQuery] string? name, CancellationToken ct)
    {
        if (Need(ApiScopes.DocumentsWrite) is { } e) return e;
        var n = string.IsNullOrWhiteSpace(name) ? $"Document {DateTime.UtcNow:yyyy-MM-dd HH.mm}.docx" : name.EndsWith(".docx", StringComparison.OrdinalIgnoreCase) ? name : name + ".docx";
        var owner = Header("X-User-Id");
        var f = await files.CreateAsync(n, WopiTemplates.BlankDocx(), string.IsNullOrEmpty(owner) ? "api:" + ClientId : owner, Actor(), ct);
        Raise(WopiEventTypes.DocumentCreated, f);
        return Created($"/api/v1/documents/{f.Id}", await Dto(f, ct));
    }

    /// <summary>GET /api/v1/documents/{id}/content?version=3</summary>
    [HttpGet("{id}/content")]
    public async Task<IActionResult> Download(string id, [FromQuery] int? version, CancellationToken ct)
    {
        if (Need(ApiScopes.DocumentsRead) is { } e) return e;
        var f = await files.GetAsync(id, ct);
        if (f is null) return Problem(404, "Document not found");
        var s = await files.OpenReadAsync(id, version, ct);
        if (s is null) return Problem(404, "Version not found");
        Response.Headers["X-Document-Version"] = (version ?? f.Version).ToString();
        return File(s, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", f.Name);
    }

    /// <summary>PUT /api/v1/documents/{id}/content — replaces the content as a new version. 409 while the document is open in the editor.</summary>
    [HttpPut("{id}/content")]
    [DisableRequestSizeLimit]
    public async Task<IActionResult> Replace(string id, CancellationToken ct)
    {
        if (Need(ApiScopes.DocumentsWrite) is { } e) return e;
        await using var _ = await locks.AcquireAsync(id, ct);
        var f = await files.GetAsync(id, ct);
        if (f is null) return Problem(404, "Document not found");
        if (await locks.GetAsync(id, ct) is not null) return Problem(409, "The document is open in the editor", "Try again after editing finishes.");
        byte[] bytes;
        try { bytes = await ReadAll(Request.Body, Opt.MaxFileBytes, ct); } catch (InvalidDataException) { return Problem(413, "The document is too large"); }
        if (bytes.Length == 0) return Problem(400, "The document is empty");
        var nf = await files.WriteAsync(id, bytes, Actor(), ct);
        Raise(WopiEventTypes.DocumentUpdated, nf);
        return Ok(await Dto(nf, ct));
    }

    [HttpGet("{id}/versions")]
    public async Task<IActionResult> Versions(string id, CancellationToken ct)
    {
        if (Need(ApiScopes.DocumentsRead) is { } e) return e;
        var f = await files.GetAsync(id, ct);
        return f is null ? Problem(404, "Document not found") : Ok(f.Versions.Reverse().Select(v => new ApiVersion(v.Version, v.SavedAt, v.SavedBy, v.Size)));
    }

    [HttpPatch("{id}")]
    public async Task<IActionResult> Rename(string id, [FromBody] ApiRename body, CancellationToken ct)
    {
        if (Need(ApiScopes.DocumentsWrite) is { } e) return e;
        await using var _ = await locks.AcquireAsync(id, ct);
        var f = await files.GetAsync(id, ct);
        if (f is null) return Problem(404, "Document not found");
        if (string.IsNullOrWhiteSpace(body?.Name)) return Problem(400, "Give a new name");
        if (await locks.GetAsync(id, ct) is not null) return Problem(409, "The document is open in the editor");
        var name = Path.HasExtension(body.Name) ? body.Name : body.Name + Path.GetExtension(f.Name);
        var nf = await files.RenameAsync(id, name, ct);
        Raise(WopiEventTypes.DocumentRenamed, nf);
        return Ok(await Dto(nf, ct));
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        if (Need(ApiScopes.DocumentsWrite) is { } e) return e;
        await using var _ = await locks.AcquireAsync(id, ct);
        var f = await files.GetAsync(id, ct);
        if (f is null) return Problem(404, "Document not found");
        if (await locks.GetAsync(id, ct) is not null) return Problem(409, "The document is open in the editor");
        await files.DeleteAsync(id, ct);
        Raise(WopiEventTypes.DocumentDeleted, f);
        return NoContent();
    }

    /// <summary>
    /// POST /api/v1/documents/{id}/sessions — an embed link that opens the editor for one of the caller's users.
    /// Load embedUrl in an iframe within its lifetime (Wopi:EmbedLinkSeconds).
    /// </summary>
    [HttpPost("{id}/sessions")]
    public async Task<IActionResult> CreateSession(string id, [FromBody] ApiSessionRequest body, CancellationToken ct)
    {
        if (Need(ApiScopes.SessionsCreate) is { } e) return e;
        var f = await files.GetAsync(id, ct);
        if (f is null) return Problem(404, "Document not found");
        if (body?.User is null || string.IsNullOrWhiteSpace(body.User.Id) || string.IsNullOrWhiteSpace(body.User.Name))
            return Problem(400, "Say who the editor is for: user.id and user.name");
        var client = Client;
        var origin = body.ParentOrigin?.TrimEnd('/');
        if (client.EmbedOrigins.Count == 0) return Problem(400, "This client has no EmbedOrigins configured");
        if (string.IsNullOrEmpty(origin)) origin = client.EmbedOrigins[0].TrimEnd('/');
        else if (!client.EmbedOrigins.Any(o => string.Equals(o.TrimEnd('/'), origin, StringComparison.OrdinalIgnoreCase)))
            return Problem(400, "parentOrigin is not one of this client's EmbedOrigins");

        // The platform's own rules still apply; the client's MaxRights caps them.
        var principal = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim(ClaimTypes.NameIdentifier, body.User.Id), new Claim("name", body.User.Name),
            new Claim(ApiKeyAuthenticationHandler.ClientIdClaim, client.Id)
        }, ApiKeyAuthenticationHandler.SchemeName));
        var rights = await perms.GetRightsAsync(principal, f, ct) & client.MaxRights;
        if (rights == WopiRights.None) return Problem(403, "This user cannot open the document");
        WopiMode mode;
        if (string.IsNullOrEmpty(body.Mode)) mode = WopiModes.Default(rights);
        else if (!WopiModes.TryParse(body.Mode, out mode)) return Problem(400, "Unknown mode", "Use edit, comment, suggest, approve or view.");
        if (!WopiModes.Allows(rights, mode)) return Problem(403, $"This user cannot open the document in {WopiModes.Name(mode)} mode");

        var exp = DateTimeOffset.UtcNow.AddSeconds(Math.Clamp(Opt.EmbedLinkSeconds, 15, 3600));
        var ticket = tokens.Protect("embed", new EmbedTicket(f.Id, body.User.Id, body.User.Name, WopiModes.Name(mode), body.Lang, client.Id, origin!, exp.ToUnixTimeMilliseconds(), (int)rights));
        var baseUrl = (string.IsNullOrEmpty(Opt.ApiPublicUrl) ? Opt.WopiSrcBase : Opt.ApiPublicUrl).TrimEnd('/');
        log.LogInformation("API session file={FileId} client={Client} user={UserId} mode={Mode}", f.Id, client.Id, body.User.Id, WopiModes.Name(mode));
        var allowed = Enum.GetValues<WopiMode>().Where(m => WopiModes.Allows(rights, m)).Select(WopiModes.Name).ToArray();
        return Ok(new ApiSession(f.Id, WopiModes.Name(mode), allowed, $"{baseUrl}/embed/{ticket}", exp));
    }

    /// <summary>GET /api/v1/documents/{id}/review — comments and tracked changes, with authors.</summary>
    [HttpGet("{id}/review")]
    public async Task<IActionResult> GetReview(string id, CancellationToken ct)
    {
        if (Need(ApiScopes.ReviewRead) is { } e) return e;
        var f = await files.GetAsync(id, ct);
        if (f is null) return Problem(404, "Document not found");
        if (!f.Name.EndsWith(".docx", StringComparison.OrdinalIgnoreCase)) return Problem(415, "Review data is available for .docx only");
        await using var s = await files.OpenReadAsync(id, null, ct);
        var bytes = await ReadAll(s!, long.MaxValue, ct);
        try { var r = DocxRevisions.Read(bytes); return Ok(new { documentId = f.Id, version = f.Version, comments = r.Comments, changes = r.Changes }); }
        catch (Exception ex) { return Problem(422, "The document could not be read", ex.Message); }
    }

    /// <summary>POST /api/v1/documents/{id}/review/accept-all or /reject-all — decides every tracked change and saves a new version.</summary>
    [HttpPost("{id}/review/{decision:regex(^(accept|reject)-all$)}")]
    public async Task<IActionResult> DecideAll(string id, string decision, CancellationToken ct)
    {
        if (Need(ApiScopes.ReviewWrite) is { } e) return e;
        await using var _ = await locks.AcquireAsync(id, ct);
        var f = await files.GetAsync(id, ct);
        if (f is null) return Problem(404, "Document not found");
        if (!f.Name.EndsWith(".docx", StringComparison.OrdinalIgnoreCase)) return Problem(415, "Review decisions are available for .docx only");
        if (await locks.GetAsync(id, ct) is not null) return Problem(409, "The document is open in the editor", "Decide in the editor, or try again when editing finishes.");
        await using var s = await files.OpenReadAsync(id, null, ct);
        var bytes = await ReadAll(s!, long.MaxValue, ct);
        var accept = decision.StartsWith("accept");
        var (result, count) = DocxRevisions.DecideAll(bytes, accept);
        if (count == 0) return Ok(new ApiDecision(decision, 0, f.Version));
        var nf = await files.WriteAsync(id, result, Actor(), ct);
        Raise(WopiEventTypes.ReviewDecided, nf, new() { ["decision"] = decision, ["count"] = count });
        return Ok(new ApiDecision(decision, count, nf.Version));
    }
}
