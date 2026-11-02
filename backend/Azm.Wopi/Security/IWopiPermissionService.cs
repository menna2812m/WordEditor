using System.Security.Claims;
using Azm.Wopi.Storage;

namespace Azm.Wopi.Security;

/// <summary>
/// Decides what the signed-in user may do with a document. Replace with your platform's rules
/// (roles, document ACLs, workflow step: drafting → Edit, legal review → Comment, change request → Suggest for the
/// initiator and Approve for the approver, signed → View) by registering your own implementation after AddWopi().
/// </summary>
public interface IWopiPermissionService
{
    Task<WopiRights> GetRightsAsync(ClaimsPrincipal user, WopiFile file, CancellationToken ct = default);
}

/// <summary>Default: every authenticated user has every right. For trials only.</summary>
public sealed class AllowAuthenticatedPermissionService : IWopiPermissionService
{
    public Task<WopiRights> GetRightsAsync(ClaimsPrincipal user, WopiFile file, CancellationToken ct = default)
        => Task.FromResult(user.Identity?.IsAuthenticated == true ? WopiRights.All : WopiRights.None);
}

public static class WopiUser
{
    public static string Id(ClaimsPrincipal u) =>
        u.FindFirstValue(ClaimTypes.NameIdentifier) ?? u.FindFirstValue("sub") ?? u.FindFirstValue("oid") ?? u.Identity?.Name ?? "anonymous";

    public static string DisplayName(ClaimsPrincipal u) =>
        u.FindFirstValue("name") ?? u.FindFirstValue(ClaimTypes.Name) ?? u.FindFirstValue("preferred_username") ?? u.FindFirstValue(ClaimTypes.Email) ?? Id(u);
}
