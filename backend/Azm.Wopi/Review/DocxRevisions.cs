using System.IO.Compression;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace Azm.Wopi.Review;

public sealed record DocxComment(string Id, string Author, string? Initials, string? Date, string Text, string AnchorText);
public sealed record DocxChange(string Id, string Type, string Author, string? Date, string Text);
public sealed record DocxReview(IReadOnlyList<DocxComment> Comments, IReadOnlyList<DocxChange> Changes);

/// <summary>Reads comments and tracked changes from a .docx, and accepts or rejects all tracked changes server-side.</summary>
public static partial class DocxRevisions
{
    private static readonly XNamespace W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    private static readonly string[] FormatChanges = ["rPrChange", "pPrChange", "sectPrChange", "tblPrChange", "trPrChange", "tcPrChange", "tblGridChange", "numberingChange"];

    private static XDocument Load(ZipArchiveEntry e)
    {
        using var s = e.Open();
        return XDocument.Load(XmlReader.Create(s, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null }), LoadOptions.PreserveWhitespace);
    }
    private static string A(XElement e, string n) => (string?)e.Attribute(W + n) ?? "";
    private static string Text(XElement e) => string.Concat(e.Descendants().Where(x => x.Name == W + "t" || x.Name == W + "delText").Select(x => x.Value));

    public static DocxReview Read(byte[] docx)
    {
        using var zip = new ZipArchive(new MemoryStream(docx), ZipArchiveMode.Read);
        var doc = Load(zip.GetEntry("word/document.xml") ?? throw new InvalidDataException("not a Word document"));
        var body = doc.Root!.Element(W + "body")!;

        // comment anchors: text between commentRangeStart and commentRangeEnd, in document order
        var anchors = new Dictionary<string, System.Text.StringBuilder>(); var open = new HashSet<string>();
        foreach (var n in body.Descendants())
        {
            if (n.Name == W + "commentRangeStart") { var id = A(n, "id"); open.Add(id); anchors[id] = new(); }
            else if (n.Name == W + "commentRangeEnd") open.Remove(A(n, "id"));
            else if ((n.Name == W + "t" || n.Name == W + "delText") && open.Count > 0) foreach (var id in open) anchors[id].Append(n.Value);
        }
        var comments = new List<DocxComment>();
        var ce = zip.GetEntry("word/comments.xml");
        if (ce is not null)
            foreach (var c in Load(ce).Root!.Elements(W + "comment"))
            {
                var id = A(c, "id");
                comments.Add(new(id, A(c, "author"), (string?)c.Attribute(W + "initials"), (string?)c.Attribute(W + "date"),
                    string.Join("\n", c.Elements(W + "p").Select(Text)), anchors.TryGetValue(id, out var sb) ? sb.ToString() : ""));
            }

        var changes = new List<DocxChange>();
        foreach (var e in body.Descendants())
        {
            var ln = e.Name.LocalName;
            if (e.Name.Namespace != W) continue;
            var inParaMark = e.Parent?.Name == W + "rPr" && e.Parent.Parent?.Name == W + "pPr";
            var inRowProps = e.Parent?.Name == W + "trPr";
            string? type = ln switch
            {
                "ins" or "moveTo" when inParaMark => "paragraph-insertion",
                "del" or "moveFrom" when inParaMark => "paragraph-deletion",
                "ins" when inRowProps => "row-insertion",
                "del" when inRowProps => "row-deletion",
                "ins" or "moveTo" when e.Parent?.Name != W + "rPr" => "insertion",
                "del" or "moveFrom" when e.Parent?.Name != W + "rPr" => "deletion",
                _ when FormatChanges.Contains(ln) => "formatting",
                _ => null
            };
            if (type is null) continue;
            var text = type is "insertion" or "deletion" ? Text(e) : type.StartsWith("paragraph") ? Text(e.Parent!.Parent!.Parent!) : "";
            changes.Add(new(A(e, "id"), type, A(e, "author"), (string?)e.Attribute(W + "date"), text));
        }
        return new DocxReview(comments, changes);
    }

    /// <summary>Accepts (or rejects) every tracked change in the body, headers, footers, footnotes and endnotes. Returns the new file and the number of changes decided.</summary>
    public static (byte[] Docx, int Count) DecideAll(byte[] docx, bool accept)
    {
        var ms = new MemoryStream(); ms.Write(docx); ms.Position = 0;
        var count = 0;
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Update, leaveOpen: true))
        {
            foreach (var entry in zip.Entries.Where(e => PartRe().IsMatch(e.FullName)).ToList())
            {
                var x = Load(entry);
                var n = Decide(x, accept);
                if (n == 0) continue;
                count += n;
                var name = entry.FullName; entry.Delete();
                var ne = zip.CreateEntry(name, CompressionLevel.Optimal);
                using var s = ne.Open();
                using var w = XmlWriter.Create(s, new XmlWriterSettings { Encoding = new System.Text.UTF8Encoding(false) });
                x.Save(w);
            }
            if (count > 0 && zip.GetEntry("word/settings.xml") is { } st)
            {   // the decided document no longer needs Word to keep recording
                var x = Load(st); var tr = x.Root?.Element(W + "trackRevisions");
                if (tr is not null) { tr.Remove(); st.Delete(); using var s = zip.CreateEntry("word/settings.xml").Open(); x.Save(s); }
            }
        }
        return (ms.ToArray(), count);
    }

    private static int Decide(XDocument x, bool accept)
    {
        var n = 0;
        // paragraph marks first (they may merge paragraphs)
        foreach (var mark in x.Descendants().Where(e => (e.Name == W + "ins" || e.Name == W + "del" || e.Name == W + "moveTo" || e.Name == W + "moveFrom") && e.Parent?.Name == W + "rPr" && e.Parent.Parent?.Name == W + "pPr").ToList())
        {
            var p = mark.Parent!.Parent!.Parent!;
            var deleted = mark.Name == W + "del" || mark.Name == W + "moveFrom";
            mark.Remove(); n++;
            if (deleted == accept) MergeWithNext(p);
        }
        // table rows
        foreach (var mark in x.Descendants().Where(e => (e.Name == W + "ins" || e.Name == W + "del") && e.Parent?.Name == W + "trPr").ToList())
        {
            var row = mark.Parent!.Parent!; var deleted = mark.Name == W + "del";
            mark.Remove(); n++;
            if (deleted == accept && row.Parent is not null) row.Remove();
        }
        // runs: process outermost first, re-query because nesting changes
        while (true)
        {
            var e = x.Descendants().FirstOrDefault(d => (d.Name == W + "ins" || d.Name == W + "del" || d.Name == W + "moveTo" || d.Name == W + "moveFrom") && d.Parent?.Name != W + "rPr" && d.Parent?.Name != W + "trPr");
            if (e is null) break;
            var inserted = e.Name == W + "ins" || e.Name == W + "moveTo";
            n++;
            if (inserted == accept)
            {
                if (!accept) foreach (var t in e.Descendants(W + "delText").ToList()) t.Name = W + "t";
                if (!accept) foreach (var t in e.Descendants(W + "delInstrText").ToList()) t.Name = W + "instrText";
                e.ReplaceWith(e.Nodes());
            }
            else e.Remove();
        }
        // formatting changes
        foreach (var fc in x.Descendants().Where(e => e.Name.Namespace == W && FormatChanges.Contains(e.Name.LocalName)).ToList())
        {
            n++;
            if (!accept)
            {
                var old = fc.Elements().FirstOrDefault();          // the previous properties element
                var holder = fc.Parent!;
                fc.Remove();
                if (old is not null)
                {
                    var keep = holder.Name == W + "pPr" ? holder.Elements().Where(c => c.Name == W + "rPr" || c.Name == W + "sectPr").ToList() : new List<XElement>();
                    holder.RemoveNodes();
                    holder.Add(old.Nodes());
                    foreach (var k in keep) holder.Add(k);
                }
            }
            else fc.Remove();
        }
        foreach (var r in x.Descendants().Where(e => e.Name.Namespace == W && (e.Name.LocalName.StartsWith("moveFromRange") || e.Name.LocalName.StartsWith("moveToRange") || e.Name.LocalName is "cellIns" or "cellDel" or "cellMerge")).ToList()) r.Remove();
        return n;
    }

    private static void MergeWithNext(XElement p)
    {
        if (p.ElementsAfterSelf().FirstOrDefault() is not { } next || next.Name != W + "p") return;
        foreach (var c in next.Nodes().Where(c => c is not XElement el || el.Name != W + "pPr").ToList()) { c.Remove(); p.Add(c); }
        next.Remove();
    }

    [GeneratedRegex(@"^word/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$")]
    private static partial Regex PartRe();
}
