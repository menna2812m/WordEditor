using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;

namespace Azm.Wopi.Storage;

/// <summary>
/// Default store: {StoragePath}/index.json plus {StoragePath}/files/{id}/{version}.bin.
/// Good for a single API instance and for trying the module. Use your own IWopiFileStore in production.
/// </summary>
public sealed partial class FileSystemWopiFileStore : IWopiFileStore
{
    private sealed class Entry
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public long Size { get; set; }
        public int Version { get; set; }
        public string Sha256 { get; set; } = "";
        public DateTimeOffset Modified { get; set; }
        public string OwnerId { get; set; } = "";
        public string ModifiedBy { get; set; } = "";
        public List<WopiFileVersion> Versions { get; set; } = new();
        public Dictionary<string, string> UserInfo { get; set; } = new();
    }

    private readonly string _root, _index;
    private readonly int _maxVersions;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private Dictionary<string, Entry> _entries;
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public FileSystemWopiFileStore(IOptions<WopiOptions> options)
    {
        _root = Path.GetFullPath(options.Value.StoragePath);
        _index = Path.Combine(_root, "index.json");
        _maxVersions = Math.Max(1, options.Value.MaxVersions);
        Directory.CreateDirectory(Path.Combine(_root, "files"));
        _entries = File.Exists(_index) ? JsonSerializer.Deserialize<Dictionary<string, Entry>>(File.ReadAllText(_index)) ?? new() : new();
    }

    private string Blob(string id, int v) => Path.Combine(_root, "files", id, $"{v}.bin");
    private static WopiFile Map(Entry e) => new(e.Id, e.Name, e.Size, e.Version, e.Sha256, e.Modified, e.OwnerId, e.ModifiedBy, e.Versions.ToList());
    private static string Hash(byte[] b) => Convert.ToBase64String(SHA256.HashData(b));
    private static DateTimeOffset Now() { var t = DateTimeOffset.UtcNow; return new DateTimeOffset(t.Ticks - t.Ticks % 10, TimeSpan.Zero); }
    public static string SafeName(string? n) { var s = BadChars().Replace(n ?? "", " ").Trim(); if (s.Length > 200) s = s[..200]; return s.Length == 0 ? "Document.docx" : s; }

    private async Task PersistAsync(CancellationToken ct)
    {
        var tmp = _index + ".tmp";
        await File.WriteAllTextAsync(tmp, JsonSerializer.Serialize(_entries, Json), ct);
        File.Move(tmp, _index, true);
    }
    private static bool ValidId(string id) => id.Length is > 0 and <= 64 && id.All(char.IsAsciiLetterOrDigit);

    public Task<WopiFile?> GetAsync(string id, CancellationToken ct = default)
        => Task.FromResult(ValidId(id) && _entries.TryGetValue(id, out var e) ? Map(e) : null);

    public Task<IReadOnlyList<WopiFile>> ListAsync(CancellationToken ct = default)
        => Task.FromResult<IReadOnlyList<WopiFile>>(_entries.Values.OrderByDescending(e => e.Modified).Select(Map).ToList());

    public Task<WopiFile?> FindByNameAsync(string name, CancellationToken ct = default)
        => Task.FromResult(_entries.Values.FirstOrDefault(e => string.Equals(e.Name, name, StringComparison.OrdinalIgnoreCase)) is { } e ? Map(e) : null);

    public Task<Stream?> OpenReadAsync(string id, int? version = null, CancellationToken ct = default)
    {
        if (!ValidId(id) || !_entries.TryGetValue(id, out var e)) return Task.FromResult<Stream?>(null);
        var v = version ?? e.Version;
        if (!e.Versions.Any(x => x.Version == v)) return Task.FromResult<Stream?>(null);
        return Task.FromResult<Stream?>(File.OpenRead(Blob(id, v)));
    }

    public async Task<WopiFile> CreateAsync(string name, byte[] content, string ownerId, string userName, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var id = Guid.NewGuid().ToString("N");
            Directory.CreateDirectory(Path.Combine(_root, "files", id));
            await File.WriteAllBytesAsync(Blob(id, 1), content, ct);
            var now = Now();
            var e = new Entry { Id = id, Name = SafeName(name), Size = content.Length, Version = 1, Sha256 = Hash(content), Modified = now, OwnerId = ownerId, ModifiedBy = userName };
            e.Versions.Add(new WopiFileVersion(1, now, userName, content.Length));
            _entries[id] = e;
            await PersistAsync(ct);
            return Map(e);
        }
        finally { _gate.Release(); }
    }

    public async Task<WopiFile> WriteAsync(string id, byte[] content, string userName, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var e = _entries[id];
            var v = e.Version + 1;
            await File.WriteAllBytesAsync(Blob(id, v), content, ct);
            var now = Now();
            e.Version = v; e.Size = content.Length; e.Sha256 = Hash(content); e.Modified = now; e.ModifiedBy = userName;
            e.Versions.Add(new WopiFileVersion(v, now, userName, content.Length));
            while (e.Versions.Count > _maxVersions) { var oldV = e.Versions[0]; e.Versions.RemoveAt(0); File.Delete(Blob(id, oldV.Version)); }
            await PersistAsync(ct);
            return Map(e);
        }
        finally { _gate.Release(); }
    }

    public async Task<WopiFile> RenameAsync(string id, string newName, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try { var e = _entries[id]; e.Name = SafeName(newName); await PersistAsync(ct); return Map(e); }
        finally { _gate.Release(); }
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            if (!ValidId(id) || !_entries.Remove(id)) return false;
            await PersistAsync(ct);
            var dir = Path.Combine(_root, "files", id);
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            return true;
        }
        finally { _gate.Release(); }
    }

    public Task<string> GetUserInfoAsync(string id, string userId, CancellationToken ct = default)
        => Task.FromResult(_entries.TryGetValue(id, out var e) && e.UserInfo.TryGetValue(userId, out var s) ? s : "");

    public async Task SetUserInfoAsync(string id, string userId, string info, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try { _entries[id].UserInfo[userId] = info.Length > 1024 ? info[..1024] : info; await PersistAsync(ct); }
        finally { _gate.Release(); }
    }

    [GeneratedRegex(@"[\\/:*?""<>|\x00-\x1f]+")]
    private static partial Regex BadChars();
}
