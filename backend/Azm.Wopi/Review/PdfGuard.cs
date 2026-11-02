using System.Text;

namespace Azm.Wopi.Review;

/// <summary>
/// Server-side check for PDF saves. Collabora opens PDF with the "view_comment" action: the pages cannot be edited,
/// only annotations added, and the editor writes the whole PDF back on save. So only comment sessions may save a PDF,
/// and the saved file must still be a PDF. The page content itself is not compared; every save is kept as a version.
/// </summary>
public static class PdfGuard
{
    public static DocxGuard.Result Check(WopiMode mode, byte[] next)
    {
        if (mode is not WopiMode.Comment) return DocxGuard.Result.Deny($"{WopiModes.Name(mode)} mode is not available for PDF (comment only)");
        return IsPdf(next) ? DocxGuard.Result.Allowed : DocxGuard.Result.Deny("saved file is not a PDF");
    }

    /// <summary>A PDF starts with "%PDF-" (within the first 1024 bytes) and ends with "%%EOF" (within the last 1024 bytes).</summary>
    public static bool IsPdf(byte[] b)
    {
        if (b.Length < 16) return false;
        var head = Encoding.ASCII.GetString(b, 0, Math.Min(1024, b.Length));
        var tail = Encoding.ASCII.GetString(b, Math.Max(0, b.Length - 1024), Math.Min(1024, b.Length));
        return head.Contains("%PDF-", StringComparison.Ordinal) && tail.Contains("%%EOF", StringComparison.Ordinal);
    }
}
