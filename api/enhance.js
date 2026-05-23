import axios from "axios";
import FormData from "form-data";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";

const BASE_URL = "https://wink.ai";
const STRATEGY_URL = "https://strategy.app.meitudata.com";
const CLIENT_ID = "1189857605";
const VERSION = "5.1.2";
const COUNTRY_CODE = "ID";
const CLIENT_LANGUAGE = "en_US";
const CLIENT_TIMEZONE = "Asia/Jakarta";
const TASK_TYPE = "12";
const CONTENT_TYPE = "1";
const EXT_VALUE = "2";
const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36";

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function extToMime(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}
function fileSuffix(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jpeg") return ".jpg";
  if (ext) return ext;
  return ".jpg";
}
function makeTrace() { return `${crypto.randomBytes(16).toString("hex")}-${crypto.randomBytes(8).toString("hex")}-1`; }

export default async function handler(req, res) {
  // Hanya menerima metode POST
  if (req.method !== 'POST') {
    return res.status(405).json({ Status: false, Error: 'Method Not Allowed' });
  }

  const { image } = req.body;
  if (!image) {
    return res.status(400).json({ Status: false, Error: 'Tidak ada gambar yang dikirim' });
  }

  // 1. Simpan base64 ke folder /tmp (standar Vercel serverless)
  const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
  const imageBuffer = Buffer.from(base64Data, 'base64');
  const tempId = crypto.randomUUID();
  const IMAGE_PATH = path.join(os.tmpdir(), `image_${tempId}.jpg`);
  
  try {
    await fsp.writeFile(IMAGE_PATH, imageBuffer);
    const TASK_NAME = `Enhancer-Ultra HD-${tempId}`;

    // 2. Setup Axios & Cookies (Sesuai script asli)
    const GNUM = crypto.randomUUID();
    const jar = new CookieJar();
    await jar.setCookie(`_sm=${GNUM}; Path=/; Domain=wink.ai`, BASE_URL);
    await jar.setCookie(`meitustat=${encodeURIComponent(JSON.stringify({ wgid: GNUM }))}; Path=/; Domain=wink.ai`, BASE_URL);

    const api = wrapper(axios.create({
      baseURL: BASE_URL,
      jar,
      withCredentials: true,
      validateStatus: () => true,
      headers: {
        accept: "*/*",
        origin: BASE_URL,
        referer: `${BASE_URL}/image-enhancer/upload`,
        "user-agent": UA,
        "sec-ch-ua": "\"Google Chrome\";v=\"147\", \"Not.A/Brand\";v=\"8\", \"Chromium\";v=\"147\"",
        "sec-ch-ua-mobile": "?1",
        "sec-ch-ua-platform": "\"Android\"",
        ab_info: JSON.stringify({ ab_codes: [], version: "1.4.4" })
      }
    }));

    function traceHeaders(transaction = "GET%20%2F%5Blocale%5D%2Fimage-enhancer%2Fupload") {
      const trace = makeTrace();
      return {
        "sentry-trace": trace,
        baggage: `sentry-environment=release,sentry-release=5.1.2%20(b60d25c477f43c6dfac4107810f26d442320f4f1),sentry-public_key=e1bf914f3448d9bc8a10c7e499d17d54,sentry-trace_id=${trace.split("-")[0]},sentry-transaction=${transaction},sentry-sampled=true,sentry-sample_rate=0.75`
      };
    }

    function baseParams(extra = {}) {
      return new URLSearchParams({
        client_id: CLIENT_ID, version: VERSION, country_code: COUNTRY_CODE, gnum: GNUM,
        client_language: CLIENT_LANGUAGE, client_channel_id: "", client_timezone: CLIENT_TIMEZONE, ...extra
      });
    }

    // Eksekusi Wink Alur (get_maat_sign, upload policy, dll)
    const signRes = await api.get(`/api/file/get_maat_sign.json?${baseParams({ suffix: fileSuffix(IMAGE_PATH), type: "temp", count: "1" }).toString()}`, { headers: traceHeaders() });
    if (signRes.status >= 400 || signRes.data?.code !== 0) throw new Error("get_maat_sign gagal");
    const sign = signRes.data.data;

    const policyRes = await axios.get(`${STRATEGY_URL}/upload/policy?${new URLSearchParams({ app: sign.app, count: String(sign.count), sig: sign.sig, sigTime: sign.sig_time, sigVersion: sign.sig_version, suffix: sign.suffix, type: sign.type }).toString()}`, {
      headers: { origin: BASE_URL, referer: `${BASE_URL}/`, "user-agent": UA }, validateStatus: () => true
    });
    if (policyRes.status >= 400 || !policyRes.data[0]?.qiniu) throw new Error("upload policy gagal");
    const policy = policyRes.data[0].qiniu;

    // Upload to Qiniu
    const form = new FormData();
    form.append("file", fs.createReadStream(IMAGE_PATH), { filename: path.basename(IMAGE_PATH), contentType: extToMime(IMAGE_PATH) });
    form.append("token", policy.token);
    form.append("key", policy.key);
    form.append("fname", path.basename(IMAGE_PATH));

    const qiniuRes = await axios.post(policy.url, form, {
      headers: form.getHeaders({ origin: BASE_URL, referer: `${BASE_URL}/`, "user-agent": UA }),
      maxBodyLength: Infinity, maxContentLength: Infinity, validateStatus: () => true
    });
    if (qiniuRes.status >= 400 || (!qiniuRes.data?.url && !qiniuRes.data?.data)) throw new Error("upload qiniu gagal");
    const uploaded = { file_key: policy.key, source_url: qiniuRes.data.url || qiniuRes.data.data };

    // Meta & Calc Beans
    await api.post("/api/file/meta_info.json", baseParams({ file_key: uploaded.file_key }).toString(), { headers: { ...traceHeaders(), "content-type": "application/x-www-form-urlencoded;charset=UTF-8" } });
    await api.post("/api/subscribe/batch_calc_need_beans.json", baseParams({ item_list: JSON.stringify([{ type: Number(TASK_TYPE), ext_value: EXT_VALUE, content_type: Number(CONTENT_TYPE), duration: 0, type_params: JSON.stringify({ is_mirror: 0, orientation_tag: 1, j_420_trans: "1", return_ext: "2" }), right_detail: JSON.stringify({ source: "1", touch_type: "4", function_id: "630", material_id: "63011", url: "https://wink.ai/image-enhancer/upload" }) }]) }).toString(), { headers: { ...traceHeaders(), "content-type": "application/x-www-form-urlencoded;charset=UTF-8" } });

    // Delivery & Wait
    const taskRes = await api.post("/api/meitu_ai/delivery.json", baseParams({ type: TASK_TYPE, content_type: CONTENT_TYPE, source_url: uploaded.source_url, type_params: JSON.stringify({ is_mirror: 0, orientation_tag: 1, j_420_trans: "1", return_ext: "2" }), right_detail: JSON.stringify({ source: "1", touch_type: "4", function_id: "630", material_id: "63011", url: "https://wink.ai/image-enhancer/upload" }), ext_params: JSON.stringify({ task_name: TASK_NAME, records: TASK_TYPE }), with_prepare: "1" }).toString(), { headers: { ...traceHeaders(), "content-type": "application/x-www-form-urlencoded;charset=UTF-8" } });
    const firstMsgId = taskRes.data?.data?.msg_id || taskRes.data?.data?.prepare_msg_id;
    if (!firstMsgId) throw new Error("delivery tidak mengembalikan msg_id");

    // Loop Wait (Disesuaikan agar tidak RTO di Vercel, max 10 detik direkomendasikan)
    let msgId = firstMsgId;
    let resultUrl = null;
    
    for (let i = 1; i <= 20; i++) { // Kurangi loop untuk Vercel timeout (Serverless gratis batas 10-15s)
      const qRes = await api.get(`/api/meitu_ai/query_batch.json?${baseParams({ msg_ids: msgId }).toString()}`, { headers: { ...traceHeaders("%2F%3Alocale%2Feditor%2Frecent-task"), referer: `${BASE_URL}/image-enhancer/upload` } });
      const data = qRes.data.data;
      
      const item = data?.item_list?.[0];
      const rValue = item?.result?.result || "";
      const rMsgId = item?.result?.msg_id || item?.msg_id || "";

      if (rValue && rValue !== msgId && !rValue.startsWith("http")) {
        msgId = rValue; await sleep(1000); continue;
      }
      if (rMsgId && rMsgId !== msgId && !rMsgId.startsWith("wpr_")) {
        msgId = rMsgId; await sleep(1000); continue;
      }

      const media = item?.result?.media_info_list?.[0]?.media_data || "";
      const errorCode = item?.result?.error_code;

      if (media && media.startsWith("http") && errorCode === 0) {
        resultUrl = media;
        break;
      }
      if (errorCode && errorCode !== 29901 && errorCode !== 0) throw new Error(`task gagal: ${errorCode}`);

      await sleep(2000);
    }

    if (!resultUrl) throw new Error("Timeout: Proses rendering memakan waktu terlalu lama");

    // Cleanup tmp file
    await fsp.unlink(IMAGE_PATH).catch(() => {});

    return res.status(200).json({ Status: true, Code: 200, Result_url: resultUrl });

  } catch (error) {
    // Cleanup tmp file if error
    await fsp.unlink(IMAGE_PATH).catch(() => {});
    return res.status(500).json({ Status: false, Code: 500, Error: error.message });
  }
}
