namespace Azm.Wopi;

/// <summary>Settings bound from the "Wopi" configuration section.</summary>
public sealed class WopiOptions
{
    public const string SectionName = "Wopi";

    /// <summary>Origin of the Angular app that embeds the editor (used as PostMessageOrigin and for close/edit links). Example: https://app.example.com</summary>
    public string PublicUrl { get; set; } = "http://localhost:4200";

    /// <summary>Base URL the editor servers use to call this API's /wopi endpoints. Example: https://api.example.com</summary>
    public string WopiSrcBase { get; set; } = "http://localhost:5080";

    /// <summary>Editor discovery XML, fetched server-to-server. Example: http://collabora:9980/hosting/discovery</summary>
    public string DiscoveryUrl { get; set; } = "http://localhost:9980/hosting/discovery";

    /// <summary>Optional origin browsers should use for the editor when discovery reports an internal hostname.</summary>
    public string? ClientPublicUrl { get; set; }

    /// <summary>HMAC key for WOPI access tokens. At least 32 characters. Keep it in a secret store.</summary>
    public string TokenSecret { get; set; } = "";

    public int TokenLifetimeHours { get; set; } = 10;

    /// <summary>auto | require | off. Use "require" in production.</summary>
    public string ProofMode { get; set; } = "auto";

    /// <summary>Reject PutFile on an unlocked, non-empty file. Required by Microsoft 365 for the web; Collabora works with false.</summary>
    public bool StrictLocks { get; set; }

    /// <summary>Check every save made in Comment, Suggest and Approve mode against the previous version (DocxGuard). Keep on.</summary>
    public bool EnforceModesOnSave { get; set; } = true;

    public int LockMinutes { get; set; } = 30;
    public int MaxVersions { get; set; } = 25;
    public long MaxFileBytes { get; set; } = 100L * 1024 * 1024;
    public string BrandName { get; set; } = "ContractsEditor";

    /// <summary>Folder for the default file-system store. Ignored when you register your own IWopiFileStore.</summary>
    public string StoragePath { get; set; } = "wopi-data";

    /// <summary>Angular route that opens a document, used for HostEditUrl. {id} is replaced.</summary>
    public string EditRoute { get; set; } = "/documents/{id}/edit";

    /// <summary>Angular route the editor's Close button returns to.</summary>
    public string CloseRoute { get; set; } = "/documents";

    /// <summary>External applications allowed to call the public API (/api/v1). Empty = public API disabled.</summary>
    public List<WopiApiClientOptions> ApiClients { get; set; } = new();

    /// <summary>Address browsers use to reach this API, for embed links (e.g. https://api.example.com). Defaults to WopiSrcBase.</summary>
    public string? ApiPublicUrl { get; set; }

    /// <summary>Default request limit per API client per minute (token bucket; short bursts allowed). 0 = unlimited.</summary>
    public int ApiRequestsPerMinute { get; set; } = 600;

    /// <summary>Delivery attempts per webhook before it moves to the dead-letter folder (backoff 4^n s, capped at 1 h).</summary>
    public int WebhookMaxAttempts { get; set; } = 10;

    /// <summary>Lifetime of an embed link returned by POST /api/v1/documents/{id}/sessions.</summary>
    public int EmbedLinkSeconds { get; set; } = 120;

    /// <summary>Authorization policy for operator endpoints (/api/wopi/webhooks). Null = those endpoints are disabled.</summary>
    public string? AdminPolicy { get; set; }

    /// <summary>Authorization policy for POST /api/wopi/sessions. Null uses the default policy (any authenticated user).</summary>
    public string? SessionPolicy { get; set; }
}

/// <summary>An external application allowed to use the public API.</summary>
public sealed class WopiApiClientOptions
{
    /// <summary>Stable identifier, e.g. "erp". Appears in audit logs and webhooks.</summary>
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";

    /// <summary>SHA-256 (hex) of the API key. Generate with WopiApiKeys.Create(); never store the key itself.</summary>
    public string KeySha256 { get; set; } = "";

    /// <summary>documents.read, documents.write, sessions.create, review.read, review.write.</summary>
    public List<string> Scopes { get; set; } = new();

    /// <summary>Most a user acting through this client can do, e.g. "Comment, Suggest, View". Default: everything.</summary>
    public WopiRights MaxRights { get; set; } = WopiRights.All;

    /// <summary>Origins allowed to embed the editor in an iframe, e.g. https://erp.example.com.</summary>
    public List<string> EmbedOrigins { get; set; } = new();

    /// <summary>HTTPS endpoint that receives webhook events. Empty = no webhooks.</summary>
    public string? WebhookUrl { get; set; }

    /// <summary>Secret used to sign webhook payloads (X-ContractsEditor-Signature).</summary>
    public string? WebhookSecret { get; set; }

    /// <summary>Overrides Wopi:ApiRequestsPerMinute for this client. 0 = use the default.</summary>
    public int RequestsPerMinute { get; set; }

    /// <summary>Event types to send; empty = all (document.created, document.updated, document.renamed, document.deleted, review.decided).</summary>
    public List<string> WebhookEvents { get; set; } = new();
}
