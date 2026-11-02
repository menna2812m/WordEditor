using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Azm.Wopi.Events;

public sealed record WebhookDelivery(
    string Id, string EventId, string ClientId, string EventType, string Body,
    int Attempts, DateTimeOffset NextAttemptAt, string? LastError, DateTimeOffset CreatedAt);

/// <summary>
/// Durable store for outgoing webhooks. The default keeps one JSON file per delivery under {StoragePath}/webhooks.
/// With several API instances, implement this on the platform database (an outbox table with a "claimed until" column)
/// or a message broker, and register it after AddWopi().
/// </summary>
public interface IWebhookOutbox
{
    void Enqueue(WebhookDelivery d);
    IReadOnlyList<WebhookDelivery> Due(DateTimeOffset now, int max);
    int CountPending();
    void Complete(string id);
    void Reschedule(WebhookDelivery d);
    void DeadLetter(WebhookDelivery d);
    IReadOnlyList<WebhookDelivery> DeadLetters(int max = 200);
    /// <summary>Moves a dead-lettered delivery back to the queue, due now with its attempt count reset. Returns false if not found.</summary>
    bool Redeliver(string id);
}

public sealed class FileWebhookOutbox : IWebhookOutbox
{
    private readonly string _pending, _dead;
    private readonly object _gate = new();
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = false };

    public FileWebhookOutbox(IOptions<WopiOptions> options)
    {
        var root = Path.Combine(Path.GetFullPath(options.Value.StoragePath), "webhooks");
        _pending = Path.Combine(root, "pending"); _dead = Path.Combine(root, "dead");
        Directory.CreateDirectory(_pending); Directory.CreateDirectory(_dead);
    }

    private static string Safe(string id) => new(id.Where(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-').ToArray());
    private static void WriteAtomic(string path, WebhookDelivery d)
    {
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(d, Json));
        File.Move(tmp, path, true);
    }
    private static WebhookDelivery? ReadFile(string path)
    {
        try { return JsonSerializer.Deserialize<WebhookDelivery>(File.ReadAllText(path), Json); } catch { return null; }
    }

    public void Enqueue(WebhookDelivery d) { lock (_gate) WriteAtomic(Path.Combine(_pending, Safe(d.Id) + ".json"), d); }

    public IReadOnlyList<WebhookDelivery> Due(DateTimeOffset now, int max)
    {
        lock (_gate)
            return Directory.EnumerateFiles(_pending, "*.json").Select(ReadFile).Where(d => d is not null && d.NextAttemptAt <= now)
                .OrderBy(d => d!.CreatedAt).Take(max).ToList()!;
    }

    public int CountPending() => Directory.EnumerateFiles(_pending, "*.json").Count();

    public void Complete(string id) { lock (_gate) File.Delete(Path.Combine(_pending, Safe(id) + ".json")); }

    public void Reschedule(WebhookDelivery d) { lock (_gate) WriteAtomic(Path.Combine(_pending, Safe(d.Id) + ".json"), d); }

    public void DeadLetter(WebhookDelivery d)
    {
        lock (_gate)
        {
            WriteAtomic(Path.Combine(_dead, Safe(d.Id) + ".json"), d);
            File.Delete(Path.Combine(_pending, Safe(d.Id) + ".json"));
        }
    }

    public IReadOnlyList<WebhookDelivery> DeadLetters(int max = 200)
    {
        lock (_gate)
            return Directory.EnumerateFiles(_dead, "*.json").Select(ReadFile).Where(d => d is not null).OrderByDescending(d => d!.CreatedAt).Take(max).ToList()!;
    }

    public bool Redeliver(string id)
    {
        lock (_gate)
        {
            var path = Path.Combine(_dead, Safe(id) + ".json");
            var d = File.Exists(path) ? ReadFile(path) : null;
            if (d is null) return false;
            WriteAtomic(Path.Combine(_pending, Safe(id) + ".json"), d with { Attempts = 0, NextAttemptAt = DateTimeOffset.UtcNow, LastError = null });
            File.Delete(path);
            return true;
        }
    }
}
