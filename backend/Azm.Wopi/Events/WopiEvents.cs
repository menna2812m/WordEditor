using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Azm.Wopi.Events;

public static class WopiEventTypes
{
    public const string DocumentCreated = "document.created";
    public const string DocumentUpdated = "document.updated";
    public const string DocumentRenamed = "document.renamed";
    public const string DocumentDeleted = "document.deleted";
    public const string ReviewDecided = "review.decided";
}

/// <summary>Publishes document events to the configured webhooks. Inject it to raise your own events too.</summary>
public interface IWopiEvents
{
    /// <summary>Queues the event durably for every subscribed client before returning.</summary>
    void Publish(string type, IReadOnlyDictionary<string, object?> data);
}

/// <summary>
/// Delivers queued webhooks from the outbox, signed with
/// X-ContractsEditor-Signature: t={unix seconds},v1={hex HMAC-SHA256 of "{t}.{body}" with the client's WebhookSecret}.
/// Each delivery is stored before Publish returns, survives restarts, is retried with backoff (4^n seconds, at most 1 hour apart)
/// up to Wopi:WebhookMaxAttempts, then moved to the dead-letter store. Delivery is at-least-once: receivers de-duplicate by event id.
/// </summary>
public sealed class WebhookDispatcher : BackgroundService, IWopiEvents
{
    private readonly IOptionsMonitor<WopiOptions> _opt;
    private readonly IWebhookOutbox _outbox;
    private readonly HttpClient _http;
    private readonly ILogger<WebhookDispatcher> _log;
    private readonly SemaphoreSlim _wake = new(0);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public WebhookDispatcher(IOptionsMonitor<WopiOptions> opt, IWebhookOutbox outbox, IHttpClientFactory http, ILogger<WebhookDispatcher> log)
    { _opt = opt; _outbox = outbox; _http = http.CreateClient("Azm.Wopi.Webhooks"); _log = log; }

    public void Publish(string type, IReadOnlyDictionary<string, object?> data)
    {
        var id = "evt_" + Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;
        foreach (var c in _opt.CurrentValue.ApiClients)
        {
            if (string.IsNullOrEmpty(c.WebhookUrl)) continue;
            if (c.WebhookEvents.Count > 0 && !c.WebhookEvents.Contains(type)) continue;
            var body = JsonSerializer.Serialize(new { id, type, createdAt = now, client = c.Id, data }, Json);
            _outbox.Enqueue(new WebhookDelivery($"{id}_{c.Id}", id, c.Id, type, body, 0, now, null, now));
        }
        _wake.Release();
    }

    public static string Sign(string secret, long timestamp, string body)
    {
        using var h = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        return Convert.ToHexString(h.ComputeHash(Encoding.UTF8.GetBytes($"{timestamp}.{body}"))).ToLowerInvariant();
    }

    /// <summary>Delay before attempt n+1 after n failures: 4, 16, 64 … seconds, at most one hour.</summary>
    public static TimeSpan Backoff(int failures) => TimeSpan.FromSeconds(Math.Min(3600, Math.Pow(4, Math.Max(1, failures))));

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        var pending = _outbox.CountPending();
        if (pending > 0) _log.LogInformation("Webhook outbox: resuming {Count} pending deliveries", pending);
        while (!stop.IsCancellationRequested)
        {
            try
            {
                var due = _outbox.Due(DateTimeOffset.UtcNow, 50);
                await Parallel.ForEachAsync(due, new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = stop }, async (d, ct) => await DeliverAsync(d, ct));
                if (due.Count == 50) continue;
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { break; }
            catch (Exception e) { _log.LogError(e, "Webhook outbox loop error"); }
            try { await _wake.WaitAsync(TimeSpan.FromSeconds(1), stop); } catch (OperationCanceledException) { break; }
        }
    }

    private async Task DeliverAsync(WebhookDelivery d, CancellationToken ct)
    {
        var client = _opt.CurrentValue.ApiClients.FirstOrDefault(c => c.Id == d.ClientId);
        if (client is null || string.IsNullOrEmpty(client.WebhookUrl)) { _outbox.DeadLetter(d with { LastError = "client or WebhookUrl no longer configured" }); return; }
        var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, client.WebhookUrl) { Content = new StringContent(d.Body, Encoding.UTF8, "application/json") };
            req.Headers.Add("X-ContractsEditor-Event", d.EventType);
            req.Headers.Add("X-ContractsEditor-Delivery", d.EventId);
            req.Headers.Add("X-ContractsEditor-Attempt", (d.Attempts + 1).ToString());
            if (!string.IsNullOrEmpty(client.WebhookSecret)) req.Headers.Add("X-ContractsEditor-Signature", $"t={ts},v1={Sign(client.WebhookSecret, ts, d.Body)}");
            req.Headers.UserAgent.Add(new ProductInfoHeaderValue("ContractsEditor-Webhooks", "1.2"));
            using var res = await _http.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode) throw new HttpRequestException($"HTTP {(int)res.StatusCode}");
            _outbox.Complete(d.Id);
            _log.LogInformation("Webhook {Type} {EventId} delivered to {Client} (attempt {Attempt})", d.EventType, d.EventId, d.ClientId, d.Attempts + 1);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            var failed = d with { Attempts = d.Attempts + 1, LastError = e.Message, NextAttemptAt = DateTimeOffset.UtcNow + Backoff(d.Attempts + 1) };
            if (failed.Attempts >= Math.Max(1, _opt.CurrentValue.WebhookMaxAttempts))
            {
                _outbox.DeadLetter(failed);
                _log.LogError("Webhook {EventId} to {Client} moved to dead letters after {Attempts} attempts: {Error}", d.EventId, d.ClientId, failed.Attempts, e.Message);
            }
            else
            {
                _outbox.Reschedule(failed);
                _log.LogWarning("Webhook {EventId} to {Client} failed (attempt {Attempt}: {Error}); next try at {Next:u}", d.EventId, d.ClientId, failed.Attempts, e.Message, failed.NextAttemptAt);
            }
        }
    }

    /// <summary>Wakes the loop, e.g. after a redelivery request.</summary>
    public void Nudge() => _wake.Release();
}
