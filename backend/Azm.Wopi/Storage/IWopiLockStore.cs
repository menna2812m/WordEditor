using System.Collections.Concurrent;
using Microsoft.Extensions.Options;

namespace Azm.Wopi.Storage;

public sealed record WopiLock(string LockId, DateTimeOffset ExpiresAt);

/// <summary>
/// WOPI locks. The default keeps them in memory, which is correct for one API instance.
/// With several instances behind a load balancer, implement this on Redis or your database.
/// </summary>
public interface IWopiLockStore
{
    Task<WopiLock?> GetAsync(string fileId, CancellationToken ct = default);
    Task SetAsync(string fileId, string lockId, CancellationToken ct = default);
    Task ClearAsync(string fileId, CancellationToken ct = default);
    /// <summary>Serialises lock-sensitive operations on one file (check-then-write).</summary>
    Task<IAsyncDisposable> AcquireAsync(string fileId, CancellationToken ct = default);
}

public sealed class InMemoryWopiLockStore : IWopiLockStore
{
    private readonly ConcurrentDictionary<string, WopiLock> _locks = new();
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _gates = new();
    private readonly TimeSpan _ttl;

    public InMemoryWopiLockStore(IOptions<WopiOptions> options) => _ttl = TimeSpan.FromMinutes(options.Value.LockMinutes);

    public Task<WopiLock?> GetAsync(string fileId, CancellationToken ct = default)
    {
        if (_locks.TryGetValue(fileId, out var l))
        {
            if (l.ExpiresAt > DateTimeOffset.UtcNow) return Task.FromResult<WopiLock?>(l);
            _locks.TryRemove(fileId, out _);
        }
        return Task.FromResult<WopiLock?>(null);
    }

    public Task SetAsync(string fileId, string lockId, CancellationToken ct = default)
    { _locks[fileId] = new WopiLock(lockId, DateTimeOffset.UtcNow.Add(_ttl)); return Task.CompletedTask; }

    public Task ClearAsync(string fileId, CancellationToken ct = default)
    { _locks.TryRemove(fileId, out _); return Task.CompletedTask; }

    public async Task<IAsyncDisposable> AcquireAsync(string fileId, CancellationToken ct = default)
    {
        var gate = _gates.GetOrAdd(fileId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        return new Releaser(gate);
    }

    private sealed class Releaser(SemaphoreSlim gate) : IAsyncDisposable
    {
        public ValueTask DisposeAsync() { gate.Release(); return ValueTask.CompletedTask; }
    }
}
