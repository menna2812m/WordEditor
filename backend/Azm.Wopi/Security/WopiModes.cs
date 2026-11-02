namespace Azm.Wopi;

/// <summary>How a document is opened.</summary>
public enum WopiMode
{
    /// <summary>Read only.</summary>
    View,
    /// <summary>Read and add comments; the text cannot change (Collabora UserCanOnlyComment).</summary>
    Comment,
    /// <summary>Initiator: every edit must be a tracked change for an approver to decide on.</summary>
    Suggest,
    /// <summary>Approver: accept or reject tracked changes and comment; no new edits.</summary>
    Approve,
    /// <summary>Full editing.</summary>
    Edit
}

/// <summary>What a user may do with a document. Combine flags, e.g. Comment | Suggest.</summary>
[Flags]
public enum WopiRights
{
    None = 0,
    View = 1,
    Comment = 2,
    Suggest = 4,
    Approve = 8,
    Edit = 16,
    All = View | Comment | Suggest | Approve | Edit
}

public static class WopiModes
{
    public static bool TryParse(string? s, out WopiMode mode)
    {
        mode = WopiMode.Edit;
        switch ((s ?? "").Trim().ToLowerInvariant())
        {
            case "view": case "read": mode = WopiMode.View; return true;
            case "comment": mode = WopiMode.Comment; return true;
            case "suggest": case "initiator": case "review": mode = WopiMode.Suggest; return true;
            case "approve": case "approver": mode = WopiMode.Approve; return true;
            case "edit": mode = WopiMode.Edit; return true;
            default: return false;
        }
    }

    public static string Name(WopiMode m) => m.ToString().ToLowerInvariant();

    public static bool Allows(WopiRights rights, WopiMode m) => m switch
    {
        WopiMode.View => rights != WopiRights.None,
        WopiMode.Comment => rights.HasFlag(WopiRights.Comment) || rights.HasFlag(WopiRights.Edit),
        WopiMode.Suggest => rights.HasFlag(WopiRights.Suggest) || rights.HasFlag(WopiRights.Edit),
        WopiMode.Approve => rights.HasFlag(WopiRights.Approve),
        WopiMode.Edit => rights.HasFlag(WopiRights.Edit),
        _ => false
    };

    /// <summary>The richest mode the rights allow, used when the caller does not ask for one.</summary>
    public static WopiMode Default(WopiRights r) =>
        r.HasFlag(WopiRights.Edit) ? WopiMode.Edit : r.HasFlag(WopiRights.Approve) ? WopiMode.Approve :
        r.HasFlag(WopiRights.Suggest) ? WopiMode.Suggest : r.HasFlag(WopiRights.Comment) ? WopiMode.Comment : WopiMode.View;

    /// <summary>Modes that save content (UserCanWrite = true in CheckFileInfo).</summary>
    public static bool Writes(WopiMode m) => m != WopiMode.View;

    /// <summary>
    /// Discovery actions to look for, best first. "view_comment" is what Collabora offers for PDF:
    /// the pages cannot change, but annotations (comments) can be added and saved.
    /// </summary>
    public static string[] Actions(WopiMode m) => m == WopiMode.View ? ["view", "edit", "view_comment"] : ["edit", "view_comment", "view"];

    /// <summary>The mode a session really gets once the editor action for the file type is known.</summary>
    public static WopiMode ForAction(string action, WopiMode requested, WopiRights rights) => action switch
    {
        "edit" => requested,
        "view_comment" when requested != WopiMode.View && Allows(rights, WopiMode.Comment) => WopiMode.Comment,
        _ => WopiMode.View
    };

    /// <summary>The rights a mode implies on its own, for callers that only know the mode that was granted.</summary>
    public static WopiRights Implied(WopiMode m) => m switch
    {
        WopiMode.Edit => WopiRights.All,
        WopiMode.Approve => WopiRights.View | WopiRights.Approve,
        WopiMode.Suggest => WopiRights.View | WopiRights.Suggest,
        WopiMode.Comment => WopiRights.View | WopiRights.Comment,
        _ => WopiRights.View
    };
}
