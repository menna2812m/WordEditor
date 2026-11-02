using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace Azm.Wopi.Proof;

/// <summary>Validates X-WOPI-Proof / X-WOPI-ProofOld signatures sent by the editor servers.</summary>
public static class WopiProofValidator
{
    private static readonly TimeSpan MaxAge = TimeSpan.FromMinutes(20);

    public static byte[] ExpectedBytes(string accessToken, string url, long timestamp)
    {
        var tok = Encoding.UTF8.GetBytes(accessToken);
        var u = Encoding.UTF8.GetBytes(url.ToUpperInvariant());
        var buf = new byte[4 + tok.Length + 4 + u.Length + 4 + 8];
        var span = buf.AsSpan(); var o = 0;
        BinaryPrimitives.WriteInt32BigEndian(span[o..], tok.Length); o += 4; tok.CopyTo(span[o..]); o += tok.Length;
        BinaryPrimitives.WriteInt32BigEndian(span[o..], u.Length); o += 4; u.CopyTo(span[o..]); o += u.Length;
        BinaryPrimitives.WriteInt32BigEndian(span[o..], 8); o += 4;
        BinaryPrimitives.WriteInt64BigEndian(span[o..], timestamp);
        return buf;
    }

    public static (bool Ok, string? Reason) Validate(string? proof, string? proofOld, string? timestamp, string accessToken, string url, RSA? current, RSA? old, DateTime? utcNow = null)
    {
        if (string.IsNullOrEmpty(proof) || string.IsNullOrEmpty(timestamp)) return (false, "missing proof headers");
        if (!long.TryParse(timestamp, out var ticks) || ticks <= 0 || ticks > DateTime.MaxValue.Ticks) return (false, "bad timestamp");
        var age = (utcNow ?? DateTime.UtcNow) - new DateTime(ticks, DateTimeKind.Utc);
        if (age.Duration() > MaxAge) return (false, "timestamp too old");
        var data = ExpectedBytes(accessToken, url, ticks);
        if (Verify(proof, data, current)) return (true, null);
        if (Verify(proofOld, data, current)) return (true, null);
        if (Verify(proof, data, old)) return (true, null);
        return (false, "signature mismatch");
    }

    private static bool Verify(string? sigB64, byte[] data, RSA? key)
    {
        if (key is null || string.IsNullOrEmpty(sigB64)) return false;
        try { return key.VerifyData(data, Convert.FromBase64String(sigB64), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1); }
        catch { return false; }
    }

    public static RSA? KeyFromModulusExponent(string? modulusB64, string? exponentB64)
    {
        if (string.IsNullOrEmpty(modulusB64) || string.IsNullOrEmpty(exponentB64)) return null;
        var rsa = RSA.Create();
        rsa.ImportParameters(new RSAParameters { Modulus = Convert.FromBase64String(modulusB64), Exponent = Convert.FromBase64String(exponentB64) });
        return rsa;
    }
}
