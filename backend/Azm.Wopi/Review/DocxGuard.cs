using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace Azm.Wopi.Review;

/// <summary>
/// Server-side enforcement of review modes. Compares the document text before and after a save:
/// <list type="bullet">
/// <item><b>Comment</b>: the body text and tracked changes must be unchanged; only comments may differ.</item>
/// <item><b>Suggest</b> (initiator): the original text (every suggestion rejected) must be unchanged, so all edits are tracked changes;
/// changes attributed to other people must already have existed.</item>
/// <item><b>Approve</b>: the approver may accept or reject existing changes and make their own edits, but only as tracked
/// changes in their own name. With the approver's own changes rejected, the result must be reachable from the previous
/// version by accepting or rejecting its existing changes.</item>
/// </list>
/// Checks cover the main document body text (paragraphs, tables, tabs, line breaks, pictures as placeholders).
/// Formatting-only changes, headers/footers and footnotes are not compared.
/// </summary>
public static class DocxGuard
{
    public enum Kind { Plain, Ins, Del, MarkIns, MarkDel }
    public sealed record Segment(Kind Kind, string Text, string Author);

    private static readonly XNamespace W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    private const char InsOpen = '\u0001', InsClose = '\u0002', DelOpen = '\u0003', DelClose = '\u0004', MarkInsCh = '\u0005', MarkDelCh = '\u0006';

    public sealed record Result(bool Ok, string? Reason)
    {
        public static readonly Result Allowed = new(true, null);
        public static Result Deny(string reason) => new(false, reason);
    }

    /// <summary>Checks a save made in the given mode. Unknown or non-Word content is allowed through (nothing to compare).</summary>
    public static Result Check(WopiMode mode, byte[] previous, byte[] next, string userName)
    {
        if (mode is WopiMode.Edit) return Result.Allowed;
        if (mode is WopiMode.View) return Result.Deny("read-only session");
        List<Segment> a, b;
        try { a = Read(previous); }
        catch { return Result.Allowed; }                 // previous version is not a .docx we can read
        try { b = Read(next); }
        catch (Exception e) { return Result.Deny("saved file is not a readable Word document: " + e.Message); }

        switch (mode)
        {
            case WopiMode.Comment:
                return Full(a) == Full(b) ? Result.Allowed : Result.Deny("document text changed in a comment-only session");
            case WopiMode.Suggest:
            {
                if (Baseline(a) != Baseline(b)) return Result.Deny("untracked edit in a suggest-only session (the original text changed)");
                var before = a.Where(IsRevision).Select(Key).GroupBy(k => k).ToDictionary(g => g.Key, g => g.Count());
                foreach (var s in b.Where(x => IsRevision(x) && !string.Equals(x.Author, userName, StringComparison.Ordinal)))
                {
                    var k = Key(s);
                    if (!before.TryGetValue(k, out var n) || n == 0) return Result.Deny($"a tracked change attributed to '{s.Author}' was added or altered");
                    before[k] = n - 1;
                }
                return Result.Allowed;
            }
            case WopiMode.Approve:
            {
                var pattern = new StringBuilder("^");
                foreach (var s in a)
                {
                    var t = Regex.Escape(s.Text);
                    pattern.Append(s.Kind switch
                    {
                        Kind.Plain => t,
                        Kind.Ins => $"(?:{Esc(InsOpen)}{t}{Esc(InsClose)}|{t}|)",
                        Kind.Del => $"(?:{Esc(DelOpen)}{t}{Esc(DelClose)}||{t})",
                        Kind.MarkIns => $"(?:{Esc(MarkInsCh)}|\\n|)",
                        Kind.MarkDel => $"(?:{Esc(MarkDelCh)}||\\n)",
                        _ => t
                    });
                }
                pattern.Append('$');
                try
                {
                    var ok = Regex.IsMatch(Full(RejectAuthoredBy(b, userName)), pattern.ToString(), RegexOptions.NonBacktracking | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(5));
                    return ok ? Result.Allowed : Result.Deny("untracked edit, or a tracked change attributed to someone else, in an approve session");
                }
                catch (RegexMatchTimeoutException) { return Result.Deny("document too complex to verify"); }
            }
            default: return Result.Allowed;
        }
    }

    /// <summary>The document as it would be if every change made by <paramref name="author"/> were rejected.</summary>
    public static List<Segment> RejectAuthoredBy(IEnumerable<Segment> segs, string author)
    {
        var o = new List<Segment>();
        foreach (var s in segs)
        {
            if (s.Kind == Kind.Plain || !string.Equals(s.Author, author, StringComparison.Ordinal)) { o.Add(s); continue; }
            switch (s.Kind)
            {
                case Kind.Del: o.Add(new(Kind.Plain, s.Text, "")); break;
                case Kind.MarkDel: o.Add(new(Kind.Plain, "\n", "")); break;
                // Ins and MarkIns by the author disappear
            }
        }
        return o;
    }

    private static string Esc(char c) => "\\u" + ((int)c).ToString("X4");
    private static bool IsRevision(Segment s) => s.Kind != Kind.Plain;
    private static string Key(Segment s) => $"{(int)s.Kind}|{s.Author}|{s.Text}";

    /// <summary>Text with revision markers; equal for two documents with the same content and the same pending changes.</summary>
    public static string Full(IEnumerable<Segment> segs)
    {
        var sb = new StringBuilder();
        foreach (var s in segs)
            sb.Append(s.Kind switch
            {
                Kind.Plain => s.Text,
                Kind.Ins => InsOpen + s.Text + InsClose,
                Kind.Del => DelOpen + s.Text + DelClose,
                Kind.MarkIns => MarkInsCh.ToString(),
                Kind.MarkDel => MarkDelCh.ToString(),
                _ => ""
            });
        return sb.ToString();
    }

    /// <summary>The original text: every pending change rejected.</summary>
    public static string Baseline(IEnumerable<Segment> segs)
    {
        var sb = new StringBuilder();
        foreach (var s in segs)
            sb.Append(s.Kind switch { Kind.Plain or Kind.Del => s.Text, Kind.MarkDel => "\n", _ => "" });
        return Normalize(sb.ToString());
    }

    /// <summary>The text with every pending change accepted.</summary>
    public static string Accepted(IEnumerable<Segment> segs)
    {
        var sb = new StringBuilder();
        foreach (var s in segs)
            sb.Append(s.Kind switch { Kind.Plain or Kind.Ins => s.Text, Kind.MarkIns => "\n", _ => "" });
        return Normalize(sb.ToString());
    }

    private static string Normalize(string s) => s.TrimEnd('\n', ' ');

    /// <summary>Reads word/document.xml into ordered segments (adjacent segments of the same kind and author merged).</summary>
    public static List<Segment> Read(byte[] docx)
    {
        using var zip = new ZipArchive(new MemoryStream(docx), ZipArchiveMode.Read);
        var entry = zip.GetEntry("word/document.xml") ?? throw new InvalidDataException("no word/document.xml");
        XDocument xml;
        using (var s = entry.Open())
            xml = XDocument.Load(XmlReader.Create(s, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null }));
        var body = xml.Root?.Element(W + "body") ?? throw new InvalidDataException("no body");
        var raw = new List<Segment>();
        Walk(body, raw, Kind.Plain, "");
        // merge neighbours, drop empties
        var segs = new List<Segment>();
        foreach (var s in raw)
        {
            if (s.Text.Length == 0 && s.Kind is Kind.Plain or Kind.Ins or Kind.Del) continue;
            if (segs.Count > 0 && segs[^1].Kind == s.Kind && segs[^1].Author == s.Author && s.Kind is Kind.Plain or Kind.Ins or Kind.Del)
                segs[^1] = segs[^1] with { Text = segs[^1].Text + s.Text };
            else segs.Add(s);
        }
        // trailing empty paragraphs are not significant
        while (segs.Count > 0 && segs[^1].Kind == Kind.Plain && segs[^1].Text.TrimEnd('\n').Length == 0) segs.RemoveAt(segs.Count - 1);
        if (segs.Count > 0 && segs[^1].Kind == Kind.Plain) segs[^1] = segs[^1] with { Text = segs[^1].Text.TrimEnd('\n') };
        return segs;
    }

    private static void Walk(XElement el, List<Segment> o, Kind ctx, string author)
    {
        foreach (var c in el.Elements())
        {
            var n = c.Name;
            if (n.Namespace != W) { if (n.LocalName is "drawing" or "pict" or "object") o.Add(new(ctx, "￼", author)); else if (n.LocalName is "AlternateContent") { var choice = c.Elements().FirstOrDefault(); if (choice is not null) Walk(choice, o, ctx, author); } continue; }
            switch (n.LocalName)
            {
                case "p":
                    Walk(c, o, ctx, author);
                    var mark = c.Element(W + "pPr")?.Element(W + "rPr");
                    var mi = mark?.Element(W + "ins"); var md = mark?.Element(W + "del");
                    if (mi is not null) o.Add(new(Kind.MarkIns, "", Author(mi)));
                    else if (md is not null) o.Add(new(Kind.MarkDel, "", Author(md)));
                    else o.Add(new(Kind.Plain, "\n", ""));
                    break;
                case "ins": case "moveTo": Walk(c, o, Kind.Ins, Author(c)); break;
                case "del": case "moveFrom": Walk(c, o, Kind.Del, Author(c)); break;
                case "t": case "delText": o.Add(new(ctx, c.Value, author)); break;
                case "tab": if (el.Name.LocalName == "r") o.Add(new(ctx, "\t", author)); break;
                case "br": case "cr": o.Add(new(ctx, "\v", author)); break;
                case "noBreakHyphen": o.Add(new(ctx, "-", author)); break;
                case "sym": o.Add(new(ctx, "�", author)); break;
                case "drawing": case "pict": case "object": o.Add(new(ctx, "￼", author)); break;
                case "tc": Walk(c, o, ctx, author); o.Add(new(Kind.Plain, "\u001F", "")); break;
                case "tr": Walk(c, o, ctx, author); o.Add(new(Kind.Plain, "\u001E", "")); break;
                // structure we descend into
                case "r": case "hyperlink": case "smartTag": case "customXml": case "fldSimple": case "sdtContent": case "tbl": case "sdt": case "dir": case "bdo":
                    Walk(c, o, ctx, author); break;
                // everything else (pPr, rPr, sectPr, bookmarks, comment anchors/references, field codes, proofErr, ...) carries no body text
            }
        }
    }

    private static string Author(XElement e) => (string?)e.Attribute(W + "author") ?? "";
}
