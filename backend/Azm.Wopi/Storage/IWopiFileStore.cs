namespace Azm.Wopi.Storage;

public sealed record WopiFileVersion(int Version, DateTimeOffset SavedAt, string SavedBy, long Size);

public sealed record WopiFile(
    string Id, string Name, long Size, int Version, string Sha256,
    DateTimeOffset Modified, string OwnerId, string ModifiedBy,
    IReadOnlyList<WopiFileVersion> Versions)
{
    /// <summary>Stable text form of Modified. Collabora sends it back in X-COOL-WOPI-Timestamp, so it must round-trip exactly.</summary>
    public string ModifiedIso => Modified.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'");
}

/// <summary>
/// Where documents live. The default implementation writes to disk; replace it with your DMS,
/// database or object storage by registering your own implementation after AddWopi().
/// </summary>
public interface IWopiFileStore
{
    Task<WopiFile?> GetAsync(string id, CancellationToken ct = default);
    Task<IReadOnlyList<WopiFile>> ListAsync(CancellationToken ct = default);
    Task<WopiFile?> FindByNameAsync(string name, CancellationToken ct = default);
    /// <summary>Opens the current content, or a specific saved version.</summary>
    Task<Stream?> OpenReadAsync(string id, int? version = null, CancellationToken ct = default);
    Task<WopiFile> CreateAsync(string name, byte[] content, string ownerId, string userName, CancellationToken ct = default);
    /// <summary>Saves new content as a new version.</summary>
    Task<WopiFile> WriteAsync(string id, byte[] content, string userName, CancellationToken ct = default);
    Task<WopiFile> RenameAsync(string id, string newName, CancellationToken ct = default);
    Task<bool> DeleteAsync(string id, CancellationToken ct = default);
    Task<string> GetUserInfoAsync(string id, string userId, CancellationToken ct = default);
    Task SetUserInfoAsync(string id, string userId, string info, CancellationToken ct = default);
}
