using Azm.Wopi.Discovery;
using Azm.Wopi.Events;
using Azm.Wopi.Proof;
using Azm.Wopi.Review;
using Azm.Wopi.Storage;
using Azm.Wopi.Tokens;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Azm.Wopi.Controllers;

/// <summary>
/// The WOPI REST API, called server-to-server by the editor (Collabora / ONLYOFFICE / Microsoft).
/// Not called by browsers. Authenticated by the access_token query parameter plus X-WOPI-Proof, never by cookies or JWT.
/// </summary>
[AllowAnonymous]
[Route("wopi/files/{id}")]
[ApiExplorerSettings(IgnoreApi = true)]
public sealed class WopiController : ControllerBase
{
    private const int MaxLockLength = 1024;
    private readonly WopiOptions _opt;
    private readonly IWopiFileStore _files;
    private readonly IWopiLockStore _locks;
    private readonly WopiAccessTokenService _tokens;
    private readonly WopiDiscoveryService _discovery;
    private readonly ILogger<WopiController> _log;
    private readonly IWopiEvents _events;

    public WopiController(IOptions<WopiOptions> opt, IWopiFileStore files, IWopiLockStore locks, WopiAccessTokenService tokens, WopiDiscoveryService discovery, IWopiEvents events, ILogger<WopiController> log)
    { _opt = opt.Value; _files = files; _locks = locks; _tokens = tokens; _discovery = discovery; _events = events; _log = log; }

    private void Raise(string type, WopiFile f, WopiAccessToken? t, string? extra = null) => _events.Publish(type, new Dictionary<string, object?>
    { ["documentId"] = f.Id, ["name"] = f.Name, ["version"] = f.Version, ["by"] = f.ModifiedBy, ["userId"] = t?.UserId, ["mode"] = t is null ? null : WopiModes.Name(t.Mode), ["source"] = "editor", ["detail"] = extra });

    // WOPI property names are PascalCase; don't let the app's camelCase JSON settings rename them.
    private static readonly System.Text.Json.JsonSerializerOptions PascalCase = new() { PropertyNamingPolicy = null, DictionaryKeyPolicy = null };
    private static JsonResult Wopi(object value, int status = 200) => new(value, PascalCase) { StatusCode = status };

    private string H(string name) => Request.Headers[name].ToString();
    private IActionResult Status(int code, params (string Name, string Value)[] headers)
    {
        foreach (var (n, v) in headers) Response.Headers[n] = v;
        return StatusCode(code);
    }
    private void Audit(string op, string id, WopiAccessToken? t, int status, string? detail = null) =>
        _log.LogInformation("WOPI {Op} file={FileId} user={UserId} status={Status} {Detail}", op, id, t?.UserId, status, detail);

    /// <summary>Token, proof and file checks shared by every endpoint.</summary>
    private async Task<(WopiAccessToken? Token, WopiFile? File, IActionResult? Error)> AuthorizeAsync(string id, string op, CancellationToken ct)
    {
        var accessToken = Request.Query["access_token"].ToString();
        var t = _tokens.Validate(accessToken);
        if (t is null || t.FileId != id) { Audit(op, id, null, 401); return (null, null, StatusCode(401)); }

        if (!await ProofOkAsync(accessToken, ct)) { Audit(op, id, t, 500, "proof rejected"); return (t, null, StatusCode(500)); }

        var f = await _files.GetAsync(id, ct);
        if (f is null) { Audit(op, id, t, 404); return (t, null, NotFound()); }
        return (t, f, null);
    }

    private async Task<bool> ProofOkAsync(string accessToken, CancellationToken ct)
    {
        var mode = _opt.ProofMode.ToLowerInvariant();
        if (mode == "off") return true;
        WopiDiscovery d;
        try { d = await _discovery.GetAsync(false, ct); }
        catch (Exception e) { _log.LogWarning(e, "WOPI discovery unavailable for proof check"); return mode != "require"; }
        if (d.ProofKey is null) return mode != "require";

        var url = _opt.WopiSrcBase.TrimEnd('/') + Request.PathBase + Request.Path + Request.QueryString;
        var r = WopiProofValidator.Validate(H("X-WOPI-Proof"), H("X-WOPI-ProofOld"), H("X-WOPI-TimeStamp"), accessToken, url, d.ProofKey, d.OldProofKey);
        if (!r.Ok && r.Reason == "signature mismatch")
        {
            try { d = await _discovery.GetAsync(true, ct); r = WopiProofValidator.Validate(H("X-WOPI-Proof"), H("X-WOPI-ProofOld"), H("X-WOPI-TimeStamp"), accessToken, url, d.ProofKey, d.OldProofKey); }
            catch { /* keep first result */ }
        }
        if (!r.Ok) _log.LogWarning("WOPI proof rejected: {Reason}", r.Reason);
        return r.Ok;
    }

    private async Task<byte[]?> ReadBodyAsync(CancellationToken ct)
    {
        using var ms = new MemoryStream();
        var buf = new byte[81920]; int n;
        while ((n = await Request.Body.ReadAsync(buf, ct)) > 0)
        {
            if (ms.Length + n > _opt.MaxFileBytes) return null;
            ms.Write(buf, 0, n);
        }
        return ms.ToArray();
    }

    private static string Ext(string name) => Path.GetExtension(name);
    private static string Base(string name) => Path.GetFileNameWithoutExtension(name);
    private string AppUrl(string route, string id) => _opt.PublicUrl.TrimEnd('/') + route.Replace("{id}", id);

    // ---------------- CheckFileInfo ----------------
    [HttpGet]
    public async Task<IActionResult> CheckFileInfo(string id, CancellationToken ct)
    {
        var (t, f, err) = await AuthorizeAsync(id, "CheckFileInfo", ct);
        if (err is not null) return err;
        var origin = t!.PostMessageOrigin ?? new Uri(_opt.PublicUrl).GetLeftPart(UriPartial.Authority);
        Audit("CheckFileInfo", id, t, 200);
        return new JsonResult(new Dictionary<string, object?>
        {
            ["BaseFileName"] = f!.Name, ["OwnerId"] = f.OwnerId, ["Size"] = f.Size, ["Version"] = f.Version.ToString(),
            ["UserId"] = t!.UserId, ["UserFriendlyName"] = t.UserName, ["IsAnonymousUser"] = false,
            ["UserCanWrite"] = t.CanWrite, ["ReadOnly"] = !t.CanWrite,
            ["UserCanRename"] = t.Mode == WopiMode.Edit, ["UserCanNotWriteRelative"] = t.Mode != WopiMode.Edit,
            // Collabora 24.04.11+: comment-only sessions
            ["UserCanOnlyComment"] = t.Mode == WopiMode.Comment,
            ["UserExtraInfo"] = new Dictionary<string, object?> { ["mode"] = WopiModes.Name(t.Mode) },
            ["SupportsLocks"] = true, ["SupportsGetLock"] = true, ["SupportsExtendedLockLength"] = true, ["SupportsUpdate"] = true,
            ["SupportsRename"] = true, ["SupportsDeleteFile"] = true, ["SupportsUserInfo"] = true,
            ["UserInfo"] = await _files.GetUserInfoAsync(id, t.UserId, ct),
            ["LastModifiedTime"] = f.ModifiedIso, ["SHA256"] = f.Sha256,
            ["BreadcrumbBrandName"] = _opt.BrandName, ["BreadcrumbBrandUrl"] = _opt.PublicUrl,
            ["BreadcrumbFolderName"] = "Documents", ["BreadcrumbFolderUrl"] = AppUrl(_opt.CloseRoute, id), ["BreadcrumbDocName"] = f.Name,
            ["CloseUrl"] = AppUrl(_opt.CloseRoute, id), ["HostEditUrl"] = AppUrl(_opt.EditRoute, id),
            ["PostMessageOrigin"] = origin,
            // Collabora Online extensions
            ["EnableOwnerTermination"] = false, ["HideExportOption"] = false, ["HidePrintOption"] = false, ["EnableShare"] = false
        }, PascalCase) { StatusCode = 200 };
    }

    // ---------------- GetFile ----------------
    [HttpGet("contents")]
    public async Task<IActionResult> GetFile(string id, CancellationToken ct)
    {
        var (t, f, err) = await AuthorizeAsync(id, "GetFile", ct);
        if (err is not null) return err;
        if (long.TryParse(H("X-WOPI-MaxExpectedSize"), out var max) && f!.Size > max) { Audit("GetFile", id, t, 412); return StatusCode(412); }
        var stream = await _files.OpenReadAsync(id, null, ct);
        if (stream is null) { Audit("GetFile", id, t, 404); return NotFound(); }
        Response.Headers["X-WOPI-ItemVersion"] = f!.Version.ToString();
        Audit("GetFile", id, t, 200);
        return File(stream, "application/octet-stream");
    }

    // ---------------- PutFile ----------------
    [HttpPost("contents")]
    [DisableRequestSizeLimit]
    public async Task<IActionResult> PutFile(string id, CancellationToken ct)
    {
        var (t, f, err) = await AuthorizeAsync(id, "PutFile", ct);
        if (err is not null) return err;
        var ov = H("X-WOPI-Override").ToUpperInvariant();
        if (ov is not ("PUT" or "")) { Audit("PutFile", id, t, 501); return StatusCode(501); }
        if (!t!.CanWrite) { Audit("PutFile", id, t, 401); return StatusCode(401); }

        await using var _ = await _locks.AcquireAsync(id, ct);
        f = await _files.GetAsync(id, ct);
        var current = await _locks.GetAsync(id, ct);
        var reqLock = H("X-WOPI-Lock");
        if (current is not null && current.LockId != reqLock) { Audit("PutFile", id, t, 409, "lock mismatch"); return Status(409, ("X-WOPI-Lock", current.LockId), ("X-WOPI-LockFailureReason", "Locked by another client")); }
        if (current is null && _opt.StrictLocks && f!.Size > 0) { Audit("PutFile", id, t, 409, "not locked"); return Status(409, ("X-WOPI-Lock", ""), ("X-WOPI-LockFailureReason", "File is not locked")); }

        // Collabora's save-conflict check: someone else changed the file since this editor loaded it.
        var coolTs = Request.Headers.TryGetValue("X-COOL-WOPI-Timestamp", out var a) ? a.ToString() : Request.Headers.TryGetValue("X-LOOL-WOPI-Timestamp", out var b) ? b.ToString() : null;
        if (!string.IsNullOrEmpty(coolTs) && coolTs != f!.ModifiedIso)
        { Audit("PutFile", id, t, 409, "document changed"); return Wopi(new { COOLStatusCode = 1010, LOOLStatusCode = 1010 }, 409); }

        var body = await ReadBodyAsync(ct);
        if (body is null) { Audit("PutFile", id, t, 413); return StatusCode(413); }

        // Review modes: the saved document may only differ from the previous version in the ways the mode allows.
        // PDF opens for commenting only, whatever the session mode; this check runs even with EnforceModesOnSave off.
        if (string.Equals(Ext(f!.Name), ".pdf", StringComparison.OrdinalIgnoreCase))
        {
            var pdf = PdfGuard.Check(t.Mode, body);
            if (!pdf.Ok) { Audit("PutFile", id, t, 403, $"rejected by PDF policy: {pdf.Reason}"); return StatusCode(403); }
        }
        else if (t.Mode != WopiMode.Edit && _opt.EnforceModesOnSave)
        {
            if (!string.Equals(Ext(f!.Name), ".docx", StringComparison.OrdinalIgnoreCase))
            { Audit("PutFile", id, t, 403, $"{WopiModes.Name(t.Mode)} mode supports .docx only"); return StatusCode(403); }
            byte[] previous;
            await using (var prev = await _files.OpenReadAsync(id, null, ct))
            { using var ms = new MemoryStream(); if (prev is not null) await prev.CopyToAsync(ms, ct); previous = ms.ToArray(); }
            var verdict = DocxGuard.Check(t.Mode, previous, body, t.UserName);
            if (!verdict.Ok)
            {
                Audit("PutFile", id, t, 403, $"rejected by {WopiModes.Name(t.Mode)} policy: {verdict.Reason}");
                return StatusCode(403);
            }
        }
        var nf = await _files.WriteAsync(id, body, t.UserName, ct);
        Response.Headers["X-WOPI-ItemVersion"] = nf.Version.ToString();
        Audit("PutFile", id, t, 200, $"v{nf.Version} {nf.Size} bytes");
        Raise(WopiEventTypes.DocumentUpdated, nf, t);
        return Wopi(new { LastModifiedTime = nf.ModifiedIso });
    }

    // ---------------- POST overrides on the file ----------------
    [HttpPost]
    [DisableRequestSizeLimit]
    public async Task<IActionResult> FileOperation(string id, CancellationToken ct)
    {
        var ov = H("X-WOPI-Override").ToUpperInvariant();
        var (t, f, err) = await AuthorizeAsync(id, ov, ct);
        if (err is not null) return err;
        var reqLock = H("X-WOPI-Lock");

        await using var gate = await _locks.AcquireAsync(id, ct);
        var current = await _locks.GetAsync(id, ct);
        IActionResult Done(int code, string? detail, params (string, string)[] headers) { Audit(ov, id, t, code, detail); return Status(code, headers); }

        switch (ov)
        {
            case "LOCK":
            {
                if (string.IsNullOrEmpty(reqLock) || reqLock.Length > MaxLockLength) return Done(400, "bad lock id");
                if (Request.Headers.ContainsKey("X-WOPI-OldLock"))
                {
                    var oldLock = H("X-WOPI-OldLock");
                    if (current is null || current.LockId != oldLock) return Done(409, "old lock mismatch", ("X-WOPI-Lock", current?.LockId ?? ""), ("X-WOPI-LockFailureReason", "Old lock does not match"));
                    await _locks.SetAsync(id, reqLock, ct);
                    return Done(200, "relocked", ("X-WOPI-ItemVersion", f!.Version.ToString()));
                }
                if (current is not null && current.LockId != reqLock) return Done(409, "locked", ("X-WOPI-Lock", current.LockId), ("X-WOPI-LockFailureReason", "Locked by another client"));
                await _locks.SetAsync(id, reqLock, ct);
                return Done(200, null, ("X-WOPI-ItemVersion", f!.Version.ToString()));
            }
            case "GET_LOCK":
                return Done(200, null, ("X-WOPI-Lock", current?.LockId ?? ""));
            case "REFRESH_LOCK":
                if (current is null || current.LockId != reqLock) return Done(409, "mismatch", ("X-WOPI-Lock", current?.LockId ?? ""), ("X-WOPI-LockFailureReason", current is null ? "File is not locked" : "Lock mismatch"));
                await _locks.SetAsync(id, reqLock, ct);
                return Done(200, null);
            case "UNLOCK":
                if (current is null || current.LockId != reqLock) return Done(409, "mismatch", ("X-WOPI-Lock", current?.LockId ?? ""), ("X-WOPI-LockFailureReason", current is null ? "File is not locked" : "Lock mismatch"));
                await _locks.ClearAsync(id, ct);
                return Done(200, null, ("X-WOPI-ItemVersion", f!.Version.ToString()));

            case "PUT_RELATIVE":
                return await PutRelativeAsync(f!, t!, ct);

            case "RENAME_FILE":
            {
                if (t!.Mode != WopiMode.Edit) return Done(401, null);
                if (current is not null && current.LockId != reqLock) return Done(409, "locked", ("X-WOPI-Lock", current.LockId));
                var requested = Utf7.Decode(H("X-WOPI-RequestedName")).Trim();
                if (requested.Length == 0 || requested.IndexOfAny(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) >= 0)
                    return Done(400, "invalid name", ("X-WOPI-InvalidFileNameError", "The name contains characters that are not allowed."));
                var target = requested + Ext(f!.Name);
                for (var i = 2; (await _files.FindByNameAsync(target, ct)) is { } other && other.Id != id; i++) target = $"{requested} ({i}){Ext(f.Name)}";
                var nf = await _files.RenameAsync(id, target, ct);
                Raise(WopiEventTypes.DocumentRenamed, nf, t);
                Audit(ov, id, t, 200, nf.Name);
                return Wopi(new { Name = Base(nf.Name) });
            }
            case "DELETE":
                if (t!.Mode != WopiMode.Edit) return Done(401, null);
                if (current is not null) return Done(409, "locked", ("X-WOPI-Lock", current.LockId));
                await _files.DeleteAsync(id, ct);
                await _locks.ClearAsync(id, ct);
                Raise(WopiEventTypes.DocumentDeleted, f!, t);
                return Done(200, null);
            case "PUT_USER_INFO":
            {
                using var reader = new StreamReader(Request.Body);
                var info = await reader.ReadToEndAsync(ct);
                await _files.SetUserInfoAsync(id, t!.UserId, info, ct);
                return Done(200, null);
            }
            default:
                return Done(501, "unsupported override");
        }
    }

    private async Task<IActionResult> PutRelativeAsync(WopiFile f, WopiAccessToken t, CancellationToken ct)
    {
        const string op = "PUT_RELATIVE";
        if (t.Mode != WopiMode.Edit) { Audit(op, f.Id, t, 401, "save-as needs edit mode"); return StatusCode(401); }
        var hasSuggested = Request.Headers.ContainsKey("X-WOPI-SuggestedTarget");
        var hasRelative = Request.Headers.ContainsKey("X-WOPI-RelativeTarget");
        if (hasSuggested == hasRelative) { Audit(op, f.Id, t, 501); return StatusCode(501); }
        var body = await ReadBodyAsync(ct);
        if (body is null) { Audit(op, f.Id, t, 413); return StatusCode(413); }

        async Task<string> Unique(string name)
        {
            if (await _files.FindByNameAsync(name, ct) is null) return name;
            for (var i = 2; ; i++) { var n = $"{Base(name)} ({i}){Ext(name)}"; if (await _files.FindByNameAsync(n, ct) is null) return n; }
        }

        string name;
        if (hasSuggested)
        {
            var s = Utf7.Decode(H("X-WOPI-SuggestedTarget"));
            name = await Unique(s.StartsWith('.') ? Base(f.Name) + s : s);
        }
        else
        {
            name = Utf7.Decode(H("X-WOPI-RelativeTarget"));
            var existing = await _files.FindByNameAsync(name, ct);
            var overwrite = string.Equals(H("X-WOPI-OverwriteRelativeTarget"), "true", StringComparison.OrdinalIgnoreCase);
            if (existing is not null && !overwrite) { Audit(op, f.Id, t, 409, "name taken"); return Status(409, ("X-WOPI-ValidRelativeTarget", Utf7.Encode(await Unique(name)))); }
            if (existing is not null)
            {
                var lk = await _locks.GetAsync(existing.Id, ct);
                if (lk is not null) { Audit(op, f.Id, t, 409, "target locked"); return Status(409, ("X-WOPI-Lock", lk.LockId)); }
                await _files.WriteAsync(existing.Id, body, t.UserName, ct);
                return RelativeResult(existing.Id, existing.Name, t);
            }
        }
        var nf = await _files.CreateAsync(name, body, t.UserId, t.UserName, ct);
        Raise(WopiEventTypes.DocumentCreated, nf, t, "save-as from " + f.Id);
        return RelativeResult(nf.Id, nf.Name, t);
    }

    private IActionResult RelativeResult(string newId, string name, WopiAccessToken t)
    {
        var (token, _) = _tokens.Issue(newId, t.UserId, t.UserName, WopiMode.Edit, TimeSpan.FromHours(_opt.TokenLifetimeHours));
        Audit("PUT_RELATIVE", newId, t, 200, name);
        return Wopi(new
        {
            Name = name,
            Url = $"{_opt.WopiSrcBase.TrimEnd('/')}/wopi/files/{newId}?access_token={Uri.EscapeDataString(token)}",
            HostEditUrl = AppUrl(_opt.EditRoute, newId),
            HostViewUrl = AppUrl(_opt.EditRoute, newId) + "?mode=view"
        });
    }
}
