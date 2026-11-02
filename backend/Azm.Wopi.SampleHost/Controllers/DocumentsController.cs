using Azm.Wopi;
using Azm.Wopi.Events;
using Azm.Wopi.Review;
using Azm.Wopi.Security;
using Azm.Wopi.Storage;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace Azm.Wopi.SampleHost.Controllers;

/// <summary>
/// Document endpoints for the Angular app: list, upload, new, download, versions, and access/save for the
/// browser-based ContractsEditor. Only Word (.docx) documents are accepted.
/// Your platform probably has its own; storage and permissions come from IWopiFileStore / IWopiPermissionService.
/// </summary>
[ApiController]
[Authorize]
[Route("api/documents")]
public sealed class DocumentsController(
    IWopiFileStore files, IWopiLockStore locks, IWopiPermissionService perms, IWopiEvents events,
    IOptionsMonitor<WopiOptions> options, ILogger<DocumentsController> log) : ControllerBase
{
    public sealed record DocumentDto(string Id, string Name, long Size, int Version, DateTimeOffset Modified, string ModifiedBy);
    /// <summary>What the ContractsEditor needs to open a document: the granted mode and who is editing.</summary>
    public sealed record AccessDto(string Id, string Name, int Version, string Mode, string[] AllowedModes, string UserName);
    private static DocumentDto Dto(WopiFile f) => new(f.Id, f.Name, f.Size, f.Version, f.Modified, f.ModifiedBy);

    [HttpGet]
    public async Task<IEnumerable<DocumentDto>> List(CancellationToken ct) => (await files.ListAsync(ct)).Select(Dto);

    [HttpPost]
    [RequestSizeLimit(100 * 1024 * 1024)]
    public async Task<ActionResult<DocumentDto>> Upload(IFormFile file, CancellationToken ct)
    {
        if (file is null || file.Length == 0) return BadRequest(new ProblemDetails { Title = "Choose a file to upload" });
        if (!string.Equals(Path.GetExtension(file.FileName), ".docx", StringComparison.OrdinalIgnoreCase))
            return BadRequest(new ProblemDetails { Title = "Only Word documents (.docx) can be uploaded" });
        using var ms = new MemoryStream();
        await file.CopyToAsync(ms, ct);
        if (!IsZip(ms.ToArray())) return BadRequest(new ProblemDetails { Title = "This file is not a valid Word document" });
        var f = await files.CreateAsync(file.FileName, ms.ToArray(), WopiUser.Id(User), WopiUser.DisplayName(User), ct);
        log.LogInformation("Upload file={FileId} user={UserId}", f.Id, WopiUser.Id(User));
        return CreatedAtAction(nameof(Download), new { id = f.Id }, Dto(f));
    }

    [HttpPost("new")]
    public async Task<ActionResult<DocumentDto>> CreateBlank([FromQuery] string? name, CancellationToken ct)
    {
        var n = string.IsNullOrWhiteSpace(name) ? $"Document {DateTime.UtcNow:yyyy-MM-dd HH.mm}.docx" : name.EndsWith(".docx", StringComparison.OrdinalIgnoreCase) ? name : name + ".docx";
        var f = await files.CreateAsync(n, WopiTemplates.BlankDocx(), WopiUser.Id(User), WopiUser.DisplayName(User), ct);
        return CreatedAtAction(nameof(Download), new { id = f.Id }, Dto(f));
    }

    [HttpGet("{id}/download")]
    public async Task<IActionResult> Download(string id, [FromQuery] int? v, CancellationToken ct)
    {
        var f = await files.GetAsync(id, ct);
        if (f is null) return NotFound();
        var s = await files.OpenReadAsync(id, v, ct);
        if (s is null) return NotFound();
        var name = v is null ? f.Name : $"{Path.GetFileNameWithoutExtension(f.Name)} (v{v}){Path.GetExtension(f.Name)}";
        return File(s, "application/octet-stream", name);
    }

    /// <summary>
    /// GET /api/documents/{id}/access?mode=edit|comment|suggest|approve|view — the mode the ContractsEditor
    /// may open the document in (omit mode for the richest the user's rights allow).
    /// </summary>
    [HttpGet("{id}/access")]
    public async Task<ActionResult<AccessDto>> Access(string id, [FromQuery] string? mode, CancellationToken ct)
    {
        var f = await files.GetAsync(id, ct);
        if (f is null) return NotFound(new ProblemDetails { Title = "Document not found" });
        var rights = await perms.GetRightsAsync(User, f, ct);
        var (granted, error) = Grant(rights, mode);
        if (error is not null) return error;
        var allowed = Enum.GetValues<WopiMode>().Where(m => WopiModes.Allows(rights, m)).Select(WopiModes.Name).ToArray();
        return new AccessDto(f.Id, f.Name, f.Version, WopiModes.Name(granted), allowed, WopiUser.DisplayName(User));
    }

    /// <summary>
    /// PUT /api/documents/{id}/content?mode=…&amp;baseVersion=N — saves a .docx from the ContractsEditor as a new version.
    /// 409 if someone saved after baseVersion (no silent overwrite); 403 if the changes break the mode's rules.
    /// </summary>
    [HttpPut("{id}/content")]
    [Consumes("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream")]
    [RequestSizeLimit(100 * 1024 * 1024)]
    public async Task<ActionResult<DocumentDto>> Save(string id, [FromQuery] string? mode, [FromQuery] int? baseVersion, CancellationToken ct)
    {
        await using var _ = await locks.AcquireAsync(id, ct);
        var f = await files.GetAsync(id, ct);
        if (f is null) return NotFound(new ProblemDetails { Title = "Document not found" });
        if (!f.Name.EndsWith(".docx", StringComparison.OrdinalIgnoreCase)) return StatusCode(415, new ProblemDetails { Title = "Only .docx documents can be saved here" });
        var (granted, error) = Grant(await perms.GetRightsAsync(User, f, ct), mode);
        if (error is not null) return error;
        if (!WopiModes.Writes(granted)) return StatusCode(403, new ProblemDetails { Title = "This document is open read-only" });
        if (baseVersion is not null && baseVersion != f.Version)
            return Conflict(new ProblemDetails { Title = "Someone saved a newer version", Detail = $"You opened v{baseVersion}; it is now v{f.Version} ({f.ModifiedBy}). Download your copy, then reopen the document." });

        using var ms = new MemoryStream();
        await Request.Body.CopyToAsync(ms, ct);
        var bytes = ms.ToArray();
        if (!IsZip(bytes)) return BadRequest(new ProblemDetails { Title = "The upload is not a .docx document" });

        // The editor runs in the browser, so the mode's rules are checked here too: comment = text unchanged,
        // suggest/approve = every edit is a tracked change in the saving user's name.
        if (granted != WopiMode.Edit && options.CurrentValue.EnforceModesOnSave)
        {
            byte[] previous;
            await using (var prev = await files.OpenReadAsync(id, null, ct))
            { using var pm = new MemoryStream(); if (prev is not null) await prev.CopyToAsync(pm, ct); previous = pm.ToArray(); }
            var verdict = DocxGuard.Check(granted, previous, bytes, WopiUser.DisplayName(User));
            if (!verdict.Ok)
            {
                log.LogWarning("ContractsEditor save rejected file={FileId} user={UserId} mode={Mode}: {Reason}", id, WopiUser.Id(User), WopiModes.Name(granted), verdict.Reason);
                return StatusCode(403, new ProblemDetails { Title = $"These changes are not allowed in {WopiModes.Name(granted)} mode", Detail = verdict.Reason });
            }
        }

        var nf = await files.WriteAsync(id, bytes, WopiUser.DisplayName(User), ct);
        events.Publish(WopiEventTypes.DocumentUpdated, new Dictionary<string, object?>
        { ["documentId"] = nf.Id, ["name"] = nf.Name, ["version"] = nf.Version, ["by"] = nf.ModifiedBy, ["userId"] = WopiUser.Id(User), ["mode"] = WopiModes.Name(granted), ["source"] = "contracts-editor" });
        log.LogInformation("ContractsEditor save file={FileId} user={UserId} mode={Mode} v={Version}", nf.Id, WopiUser.Id(User), WopiModes.Name(granted), nf.Version);
        return Dto(nf);
    }

    /// <summary>A .docx is a zip: anything without the zip signature is not one.</summary>
    private static bool IsZip(byte[] b) => b.Length >= 4 && b[0] == 'P' && b[1] == 'K';

    private (WopiMode Mode, ActionResult? Error) Grant(WopiRights rights, string? mode)
    {
        if (rights == WopiRights.None) return (WopiMode.View, Forbid());
        WopiMode requested;
        if (string.IsNullOrEmpty(mode)) requested = WopiModes.Default(rights);
        else if (!WopiModes.TryParse(mode, out requested)) return (WopiMode.View, BadRequest(new ProblemDetails { Title = "Unknown mode", Detail = "Use edit, comment, suggest, approve or view." }));
        if (!WopiModes.Allows(rights, requested))
            return (WopiMode.View, StatusCode(403, new ProblemDetails { Title = $"You cannot open this document in {WopiModes.Name(requested)} mode" }));
        return (requested, null);
    }

    [HttpGet("{id}/versions")]
    public async Task<ActionResult<IEnumerable<WopiFileVersion>>> Versions(string id, CancellationToken ct)
    {
        var f = await files.GetAsync(id, ct);
        return f is null ? NotFound() : Ok(f.Versions.Reverse());
    }
}
