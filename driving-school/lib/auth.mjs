// 管理后台登录:单一管理员密码(/etc/driving-school.env 的 DS_ADMIN_PASSWORD),
// 登录后发 HMAC 签名的 Cookie,12 小时有效。
import crypto from "node:crypto";

const COOKIE = "ds_admin";
const TTL = 12 * 3600 * 1000;

export function makeAuth({ password, secret }) {
  const key = secret || crypto.randomBytes(32).toString("hex"); // 没配密钥时每次重启都要重新登录
  const sign = v => crypto.createHmac("sha256", key).update(v).digest("base64url");
  const sha = s => crypto.createHash("sha256").update(String(s)).digest();
  return {
    enabled: !!password,
    checkPassword: p => !!password && crypto.timingSafeEqual(sha(p), sha(password)),
    issueCookie() {
      const exp = String(Date.now() + TTL);
      return `${COOKIE}=${exp}.${sign(exp)}; Path=/driving; HttpOnly; SameSite=Lax; Max-Age=${TTL / 1000}`;
    },
    clearCookie: () => `${COOKIE}=; Path=/driving; HttpOnly; SameSite=Lax; Max-Age=0`,
    verify(cookieHeader) {
      const m = String(cookieHeader || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([\\w-]+)`));
      if (!m || Number(m[1]) < Date.now()) return false;
      const a = Buffer.from(m[2]), b = Buffer.from(sign(m[1]));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}
