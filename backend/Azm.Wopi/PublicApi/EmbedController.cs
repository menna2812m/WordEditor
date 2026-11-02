using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using Azm.Wopi.Discovery;
using Azm.Wopi.Storage;
using Azm.Wopi.Tokens;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Azm.Wopi.PublicApi;

/// <summary>
/// GET /embed/{link}: the host page an external application loads in an iframe.
/// It exchanges the short-lived signed link for a WOPI session, loads the editor, configures the review mode,
/// and relays editor events to the parent window with window.postMessage.
/// </summary>
[AllowAnonymous]
[ApiExplorerSettings(IgnoreApi = true)]
public sealed class EmbedController(IOptionsMonitor<WopiOptions> options, IWopiFileStore files, WopiAccessTokenService tokens, WopiDiscoveryService discovery, ILogger<EmbedController> log) : ControllerBase
{
    [HttpGet("embed/{link}")]
    public async Task<IActionResult> Embed(string link, CancellationToken ct)
    {
        var opt = options.CurrentValue;
        var t = tokens.Unprotect<EmbedTicket>("embed", link);
        if (t is null) return Page(400, "This editor link is not valid.");
        if (t.exp < DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) return Page(410, "This editor link has expired. Open the document again.");
        var client = opt.ApiClients.FirstOrDefault(c => c.Id == t.c);
        if (client is null || !client.EmbedOrigins.Any(o => string.Equals(o.TrimEnd('/'), t.o, StringComparison.OrdinalIgnoreCase)))
            return Page(403, "This application may no longer embed the editor.");
        var f = await files.GetAsync(t.f, ct);
        if (f is null) return Page(404, "This document no longer exists.");
        if (!WopiModes.TryParse(t.m, out var mode)) return Page(400, "This editor link is not valid.");

        (string Action, string Url)? action;
        try { action = await discovery.GetActionUrlAsync(Path.GetExtension(f.Name), WopiModes.Actions(mode), ct); }
        catch (Exception e) { log.LogError(e, "Embed: editor discovery failed"); return Page(503, "The document editor is not available right now."); }
        if (action is null) return Page(415, "The editor cannot open this type of file.");
        mode = WopiModes.ForAction(action.Value.Action, mode, t.r is { } r ? (WopiRights)r : WopiModes.Implied(mode));

        var selfOrigin = $"{Request.Scheme}://{Request.Host}";
        var publicBase = string.IsNullOrEmpty(opt.ApiPublicUrl) ? selfOrigin : new Uri(opt.ApiPublicUrl).GetLeftPart(UriPartial.Authority);
        var (token, ttl) = tokens.Issue(f.Id, t.u, t.n, mode, TimeSpan.FromHours(opt.TokenLifetimeHours), publicBase);
        var editorUrl = action.Value.Url + "WOPISrc=" + Uri.EscapeDataString($"{opt.WopiSrcBase.TrimEnd('/')}/wopi/files/{f.Id}") + (string.IsNullOrEmpty(t.l) ? "" : "&lang=" + Uri.EscapeDataString(t.l));
        var editorOrigin = new Uri(action.Value.Url).GetLeftPart(UriPartial.Authority);
        var nonce = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));
        log.LogInformation("Embed opened file={FileId} client={Client} user={UserId} mode={Mode}", f.Id, t.c, t.u, WopiModes.Name(mode));

        Response.Headers["Content-Security-Policy"] = $"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; frame-src {editorOrigin}; form-action {editorOrigin}; frame-ancestors {t.o}; base-uri 'none'";
        Response.Headers["Referrer-Policy"] = "no-referrer";
        Response.Headers["Cache-Control"] = "no-store";
        var cfg = JsonSerializer.Serialize(new { editorOrigin, parentOrigin = t.o, mode = WopiModes.Name(mode), documentId = f.Id, name = f.Name });
        var html = $$"""
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{{WebUtility.HtmlEncode(f.Name)}}</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#fff}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style></head><body>
<form id="f" target="editor" action="{{WebUtility.HtmlEncode(editorUrl)}}" method="post"><input type="hidden" name="access_token" value="{{WebUtility.HtmlEncode(token)}}"><input type="hidden" name="access_token_ttl" value="{{ttl}}"></form>
<iframe name="editor" id="editor" title="{{WebUtility.HtmlEncode(f.Name)}}" allow="clipboard-read *; clipboard-write *; fullscreen" allowfullscreen></iframe>
<script nonce="{{nonce}}">
(() => {
  const C = {{cfg}};
  const frame = document.getElementById('editor');
  const toEditor = (MessageId, Values) => frame.contentWindow && frame.contentWindow.postMessage(JSON.stringify({ MessageId, SendTime: Date.now(), Values: Values || {} }), C.editorOrigin);
  const toParent = (type, data) => window.parent !== window && window.parent.postMessage({ source: 'contractseditor', type, documentId: C.documentId, ...(data || {}) }, C.parentOrigin);
  window.addEventListener('message', ev => {
    if (ev.origin === C.parentOrigin && ev.data && ev.data.source === 'contractseditor-host') {
      if (ev.data.command === 'save') toEditor('Action_Save', { DontTerminateEdit: true, DontSaveIfUnmodified: true, Notify: true });
      if (ev.data.command === 'close') toEditor('Action_Close');
      return;
    }
    if (ev.origin !== C.editorOrigin || ev.source !== frame.contentWindow) return;
    let m; try { m = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; } catch { return; }
    if (!m || !m.MessageId) return;
    const v = m.Values || {};
    if (m.MessageId === 'App_LoadingStatus' && (v.Status === 'Frame_Ready' || v.Status === 'Document_Loaded')) toEditor('Host_PostmessageReady');
    if (m.MessageId === 'App_LoadingStatus' && v.Status === 'Document_Loaded') {
      if (C.mode === 'suggest' || C.mode === 'approve') {
        toEditor('Send_UNO_Command', { Command: '.uno:TrackChanges', Args: { TrackChanges: { type: 'boolean', value: true } } });
        toEditor('Send_UNO_Command', { Command: '.uno:ShowTrackedChanges', Args: { ShowTrackedChanges: { type: 'boolean', value: true } } });
      }
      toParent('loaded', { mode: C.mode, name: C.name });
    }
    if (m.MessageId === 'App_LoadingStatus' && v.Status === 'Failed') toParent('error', { message: 'The editor could not load the document.' });
    if (m.MessageId === 'Doc_ModifiedStatus') toParent('modified', { modified: !!v.Modified });
    if (m.MessageId === 'Action_Save_Resp') toParent('saved', { success: v.success !== false });
    if (m.MessageId === 'UI_Close' || m.MessageId === 'close') toParent('closed');
  });
  document.getElementById('f').submit();
})();
</script></body></html>
""";
        return Content(html, "text/html; charset=utf-8");
    }

    private ContentResult Page(int status, string message)
    {
        Response.Headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'";
        return new ContentResult
        {
            StatusCode = status, ContentType = "text/html; charset=utf-8",
            Content = $"<!doctype html><html><head><meta charset=\"utf-8\"><title>Document</title><style>body{{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#1c2321;background:#f2f4f1}}</style></head><body><p>{WebUtility.HtmlEncode(message)}</p></body></html>"
        };
    }
}
