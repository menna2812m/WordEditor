using System.Text;
using System.Text.RegularExpressions;

namespace Azm.Wopi;

/// <summary>WOPI sends and expects file names in UTF-7 (RFC 2152) headers.</summary>
public static partial class Utf7
{
    public static string Decode(string? s)
    {
        if (string.IsNullOrEmpty(s)) return s ?? "";
        return Shift().Replace(s, m =>
        {
            var b64 = m.Groups[1].Value;
            if (b64.Length == 0) return "+";
            var padded = b64 + new string('=', (4 - b64.Length % 4) % 4);
            var bytes = Convert.FromBase64String(padded);
            return Encoding.BigEndianUnicode.GetString(bytes, 0, bytes.Length - bytes.Length % 2);
        });
    }

    public static string Encode(string s)
    {
        var sb = new StringBuilder(); var i = 0;
        while (i < s.Length)
        {
            if (Direct(s[i])) { sb.Append(s[i]); i++; continue; }
            if (s[i] == '+') { sb.Append("+-"); i++; continue; }
            var start = i;
            while (i < s.Length && !Direct(s[i]) && s[i] != '+') i++;
            var bytes = Encoding.BigEndianUnicode.GetBytes(s[start..i]);
            sb.Append('+').Append(Convert.ToBase64String(bytes).TrimEnd('=')).Append('-');
        }
        return sb.ToString();
    }

    private static bool Direct(char c) => c < 128 && c != '+' && c != '\\' && c != '~' && c >= 32;

    [GeneratedRegex(@"\+([A-Za-z0-9+/]*)-?")]
    private static partial Regex Shift();
}
