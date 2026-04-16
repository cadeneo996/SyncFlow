// ==UserScript==
// @name         云盘秒传工具（夸克/天翼/123/光鸭）
// @version      2026.04.16
// @description  云盘秒传工具（夸克/天翼/123/光鸭）
// @run-at       document-idle
// @match        https://pan.quark.cn/*
// @match        https://drive.quark.cn/*
// @match        https://cloud.189.cn/web/*
// @match        *://*.123pan.com/*
// @match        *://*.123pan.cn/*
// @match        https://www.123pan.com/*
// @match        https://www.123pan.com/
// @match        http://www.123pan.com/*
// @match        https://123pan.com/*
// @match        https://123pan.com/
// @match        http://123pan.com/*
// @match        https://guangyapan.com/*
// @match        https://*.guangyapan.com/*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      drive.quark.cn
// @connect      drive-pc.quark.cn
// @connect      pc-api.uc.cn
// @connect      cloud.189.cn
// @connect      api.guangyapan.com
// ==/UserScript==

// @ts-nocheck

(function () {
    "use strict";

    const SCRIPT_VERSION = "2026.04.16";
    const GUANGYA_API_BASE = "https://api.guangyapan.com";
    const GUANGYA_CODE_RES_TOKEN_INSTANT = 156;
    const GUANGYA_CODE_DIR_EXISTS = 159;
    const GUANGYA_URL_GET_RES_CENTER_TOKEN = `${GUANGYA_API_BASE}/nd.bizuserres.s/v1/get_res_center_token`;
    const GUANGYA_URL_CREATE_DIR = `${GUANGYA_API_BASE}/nd.bizuserres.s/v1/file/create_dir`;
    const GUANGYA_URL_DELETE_UPLOAD_TASK = `${GUANGYA_API_BASE}/nd.bizuserres.s/v1/file/delete_upload_task`;

    const KEY_GUANGYA_ACCESS_TOKEN = "guangya_guangyapan_access_token";
    const BTN_GUANGYA_IMPORT_ID = "guangya-guangya-import-json-btn";
    const INVALID_ETAG_POLICY = localStorage.getItem("guangya_etag_policy") || "skip";
    const BTN_ID = "guangya-json-generator-btn";
    const GUANGYA_BTN_TYPO_STYLE_ID = "guangya-rapid-json-typography";
    const GUANGYA_TIANYI_SHARE_STYLE_ID = "guangya-tianyi-share-flex";
    const BODY_SELECTOR = "body";
    const PREFER_123_TOOLBAR = localStorage.getItem("guangya_123_use_toolbar") !== "0";

    function guangyaJsonDetail(obj) {
        try {
            return JSON.stringify(obj, null, 2);
        } catch {
            return String(obj);
        }
    }

    /** 秒传导入 JSON 文件/文本结构校验（不含 token、不校验每条 md5 是否合法） */
    function validateGuangyaImportJsonShape(text) {
        const trim = String(text || "").trim();
        if (!trim) {
            return { ok: false, message: "文件内容为空" };
        }
        let obj;
        try {
            obj = JSON.parse(trim);
        } catch {
            return {
                ok: false,
                message: "不是合法 JSON（请检查编码、逗号、引号与括号是否匹配）",
            };
        }
        if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
            return {
                ok: false,
                message: "JSON 顶层须为对象 { … }，不能是数组或纯数字/字符串",
            };
        }
        if (!Array.isArray(obj.files)) {
            return {
                ok: false,
                message:
                    '须包含数组字段 files，例如：{"files":[{"path":"…","etag":"…","size":0},…]}',
            };
        }
        if (obj.files.length === 0) {
            return { ok: false, message: "files 数组长度为 0，没有可导入条目" };
        }
        const badIdx = [];
        for (let i = 0; i < obj.files.length; i++) {
            const it = obj.files[i];
            if (it == null || typeof it !== "object" || Array.isArray(it)) {
                badIdx.push(i);
                if (badIdx.length >= 8) break;
            }
        }
        if (badIdx.length) {
            const sample = badIdx.slice(0, 5).join("、");
            const more =
                badIdx.length > 5
                    ? ` 等共 ${badIdx.length} 处`
                    : "";
            return {
                ok: false,
                message: `files 中第 ${sample} 项${more}不是对象，每项应为 { path/name, etag/md5, size }`,
            };
        }
        return { ok: true, fileCount: obj.files.length };
    }

    function guangyaParseImportResultCounts(resp, submittedCount, skipCount) {
        const d = resp && resp.data;
        if (d != null && typeof d === "object" && !Array.isArray(d)) {
            const failedMd5s = d.failedMd5s ?? d.failed_md5s;
            if (Array.isArray(failedMd5s)) {
                const failedSet = new Set(
                    failedMd5s
                        .map((m) =>
                            String(m == null ? "" : m)
                                .trim()
                                .toLowerCase(),
                        )
                        .filter((x) => x.length > 0),
                );
                const transferFail = failedSet.size;
                const transferOk = Math.max(0, submittedCount - transferFail);
                return {
                    successCount: transferOk,
                    failCount: transferFail + skipCount,
                };
            }
            const s =
                d.successCount ??
                d.success_num ??
                d.okCount ??
                d.successTotal;
            const f =
                d.failCount ??
                d.failedCount ??
                d.fail_num ??
                d.errorCount ??
                d.failTotal;
            if (typeof s === "number" && typeof f === "number") {
                return {
                    successCount: s,
                    failCount: f + skipCount,
                };
            }
            if (typeof s === "number") {
                return {
                    successCount: s,
                    failCount:
                        (typeof f === "number" ? f : 0) + skipCount,
                };
            }
            if (typeof f === "number") {
                return {
                    successCount: submittedCount,
                    failCount: f + skipCount,
                };
            }
            const arr = d.details || d.results || d.list;
            if (Array.isArray(arr) && arr.length) {
                const failed = arr.filter((x) => {
                    if (!x || typeof x !== "object") return false;
                    if (x.success === false || x.ok === false) return true;
                    if (x.status === "fail" || x.status === "failed")
                        return true;
                    if (x.code != null && x.code !== 0) return true;
                    return false;
                }).length;
                return {
                    successCount: arr.length - failed,
                    failCount: failed + skipCount,
                };
            }
        }
        return {
            successCount: submittedCount,
            failCount: skipCount,
        };
    }

    function guangyaBasenameFromPath(filePath) {
        const s = String(filePath || "").replace(/\\/g, "/");
        const parts = s.split("/").filter(Boolean);
        return parts.length ? parts[parts.length - 1] : "file";
    }

    function guangyaDirSegmentsFromPath(filePath) {
        const s = String(filePath || "").replace(/\\/g, "/");
        const parts = s
            .split("/")
            .map((p) => String(p || "").trim())
            .filter((p) => p.length > 0);
        if (parts.length <= 1) return [];
        return parts.slice(0, -1);
    }

    function guangyaPickFileIdFromObj(obj) {
        if (!obj || typeof obj !== "object") return "";
        const id =
            obj.fileId ??
            obj.fileid ??
            obj.file_id ??
            obj.id ??
            obj.dirId ??
            obj.dir_id ??
            obj.folderId ??
            obj.folder_id;
        return id == null ? "" : String(id);
    }

    function guangyaNormMd5Token(m) {
        return String(m == null ? "" : m)
            .trim()
            .toLowerCase();
    }

    /** 单批：用 data.failedMd5s 与当批 chunk 对应出路径（无路径时仅 md5） */
    function guangyaTransferFailRowsFromResp(resp, chunk) {
        const d = resp && resp.data;
        if (!d || typeof d !== "object" || Array.isArray(d)) return [];
        const raw = d.failedMd5s ?? d.failed_md5s;
        if (!Array.isArray(raw) || raw.length === 0) return [];
        const failedSet = new Set(
            raw.map(guangyaNormMd5Token).filter((x) => x.length > 0),
        );
        const rows = [];
        const covered = new Set();
        for (const row of chunk) {
            const m = guangyaNormMd5Token(row.md5);
            if (!m || !failedSet.has(m)) continue;
            const key = `${m}\t${String(row.filePath || "")}`;
            if (covered.has(key)) continue;
            covered.add(key);
            rows.push({
                md5: row.md5 || m,
                filePath: String(row.filePath || ""),
            });
        }
        for (const m of failedSet) {
            if (chunk.some((r) => guangyaNormMd5Token(r.md5) === m)) continue;
            rows.push({ md5: m, filePath: "" });
        }
        return rows;
    }

    /**
     * @param {{ interfaceLines?: string[]; transferRows?: { md5: string; filePath: string }[]; mkdirSkipLines?: string[]; validateSkipLines?: string[]; transferExtraLines?: string[] }} parts
     */
    function formatGuangyaImportCopyReport(parts) {
        const iface = parts.interfaceLines;
        const xfer = parts.transferRows || [];
        const mkdirSkip = parts.mkdirSkipLines || [];
        const validateSkip = parts.validateSkipLines || [];
        const extra = parts.transferExtraLines || [];
        const lines = [];
        lines.push("========== 接口调用失败 ==========");
        if (iface && iface.length) lines.push(...iface.map((x) => String(x)));
        else lines.push("（无）");
        lines.push("");
        lines.push("========== 秒传失败 ==========");
        if (xfer.length) {
            for (const r of xfer) {
                const p = String(r.filePath || "").trim();
                lines.push(p || "—");
            }
        } else lines.push("（无）");
        if (extra.length) {
            lines.push(...extra.map((x) => String(x)));
        }
        if (mkdirSkip.length) {
            lines.push("");
            lines.push("========== 创建目录失败（未进入秒传） ==========");
            lines.push(...mkdirSkip.map((x) => String(x)));
        }
        if (validateSkip.length) {
            lines.push("");
            lines.push("========== 校验未通过（未提交接口） ==========");
            lines.push(...validateSkip.map((x) => String(x)));
        }
        return lines.join("\n");
    }

    /** 导出秒传 JSON 文件名：秒传_YYYYMMDD_HHmmss.json */
    function makeRapidTransferExportFilename() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        const date =
            d.getFullYear() +
            p(d.getMonth() + 1) +
            p(d.getDate());
        const time =
            p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
        return `秒传_${date}_${time}.json`;
    }

    function guangyaCreateTraceparent() {
        const hex = (len) => {
            const u = new Uint8Array(len);
            crypto.getRandomValues(u);
            return [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
        };
        return `00-${hex(16)}-${hex(8)}-01`;
    }

    const helper = {
        sleep(ms) {
            return new Promise((resolve) => setTimeout(resolve, ms));
        },

        getCookie(name) {
            const value = `; ${document.cookie}`;
            const parts = value.split(`; ${name}=`);
            if (parts.length === 2) {
                const raw = parts.pop().split(";").shift();
                if (raw == null || raw === "") return null;
                try {
                    return decodeURIComponent(raw);
                } catch {
                    return raw;
                }
            }
            return null;
        },

        get(url, headers = {}) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "GET",
                    url,
                    headers,
                    onload: (resp) => {
                        if (resp.status >= 200 && resp.status < 300) {
                            resolve(resp.responseText);
                            return;
                        }
                        reject(new Error(`请求失败: ${resp.status}`));
                    },
                    onerror: () => reject(new Error("网络请求失败")),
                });
            });
        },

        postJson(url, data, headers = {}) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "POST",
                    url,
                    headers: {
                        "Content-Type": "application/json;charset=utf-8",
                        ...headers,
                    },
                    data: JSON.stringify(data),
                    onload: (resp) => {
                        try {
                            resolve(JSON.parse(resp.responseText));
                        } catch {
                            reject(new Error("响应解析失败"));
                        }
                    },
                    onerror: () => reject(new Error("网络请求失败")),
                });
            });
        },

        /**
         * @param {string} url
         * @param {object} data
         * @param {string} bearerToken
         * @param {{ allowedBusinessCodes?: number[] }} [options] 若业务 code 非 0，需在此列出仍视为成功的 code（如 156）
         */
        postJsonGuangya(url, data, bearerToken, options) {
            const tok = String(bearerToken || "").replace(/^Bearer\s+/i, "").trim();
            const traceparent = guangyaCreateTraceparent();
            const origin =
                typeof location !== "undefined" ? location.origin : "";
            const referer =
                typeof location !== "undefined" ? location.href : "";
            const requestHeaders = {
                "Content-Type": "application/json;charset=utf-8",
                Authorization: `Bearer ${tok}`,
                dt: "4",
                traceparent,
                ...(origin ? { Origin: origin } : {}),
                ...(referer ? { Referer: referer } : {}),
            };
            const headersForLog = { ...requestHeaders };
            const bodyStr = JSON.stringify(data);
            const attachDetail = (err, extra) => {
                err.guangyaDetail = guangyaJsonDetail({
                    summary: err.message,
                    url,
                    method: "POST",
                    requestHeaders: headersForLog,
                    requestBody: data,
                    ...extra,
                });
                return err;
            };
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "POST",
                    url,
                    headers: requestHeaders,
                    data: bodyStr,
                    onload: (resp) => {
                        const raw = resp.responseText || "";
                        let parsedBody;
                        try {
                            parsedBody = JSON.parse(raw);
                        } catch {
                            parsedBody = null;
                        }
                        if (resp.status < 200 || resp.status >= 300) {
                            let short = raw;
                            try {
                                const ej = JSON.parse(raw);
                                short =
                                    ej.msg ||
                                    ej.message ||
                                    (typeof ej.error === "string"
                                        ? ej.error
                                        : "") ||
                                    ej.error_description ||
                                    raw;
                            } catch {
                                /* empty */
                            }
                            reject(
                                attachDetail(
                                    new Error(
                                        `HTTP ${resp.status}${
                                            short
                                                ? `: ${String(short).slice(0, 600)}`
                                                : ""
                                        }`,
                                    ),
                                    {
                                        httpStatus: resp.status,
                                        responseBody: parsedBody ?? raw,
                                    },
                                ),
                            );
                            return;
                        }
                        let j;
                        try {
                            j = JSON.parse(resp.responseText);
                        } catch {
                            reject(
                                attachDetail(
                                    new Error("响应解析失败"),
                                    {
                                        httpStatus: resp.status,
                                        responseTextPreview: raw.slice(
                                            0,
                                            12000,
                                        ),
                                    },
                                ),
                            );
                            return;
                        }
                        const allowed = options && options.allowedBusinessCodes;
                        const businessOk =
                            j.code == null ||
                            j.code === 0 ||
                            (Array.isArray(allowed) && allowed.includes(j.code));
                        if (j && j.code != null && !businessOk) {
                            reject(
                                attachDetail(
                                    new Error(
                                        j.msg || `接口错误 code=${j.code}`,
                                    ),
                                    {
                                        httpStatus: resp.status,
                                        responseBody: j,
                                    },
                                ),
                            );
                            return;
                        }
                        resolve({
                            data: j,
                            requestLog: {
                                url,
                                method: "POST",
                                requestHeaders: headersForLog,
                                requestBody: data,
                            },
                        });
                    },
                    onerror: () => {
                        reject(
                            attachDetail(new Error("网络请求失败"), {
                                networkError: true,
                            }),
                        );
                    },
                });
            });
        },

        postQuarkPcJson(url, data, headers = {}) {
            const QUARK_UA =
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch";
            const origin =
                typeof location !== "undefined" ? location.origin : "https://pan.quark.cn";
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "POST",
                    url,
                    headers: {
                        "Content-Type": "application/json;charset=utf-8",
                        "User-Agent": QUARK_UA,
                        Origin: origin,
                        Referer: `${origin}/`,
                        Dnt: "",
                        "Cache-Control": "no-cache",
                        Pragma: "no-cache",
                        Expires: "0",
                        ...headers,
                    },
                    data: JSON.stringify(data),
                    onload: (resp) => {
                        try {
                            resolve(JSON.parse(resp.responseText));
                        } catch {
                            reject(new Error("响应解析失败"));
                        }
                    },
                    onerror: () => reject(new Error("网络请求失败")),
                });
            });
        },

        getCachedQuarkCookie() {
            return GM_getValue("guangya_quark_cookie", "");
        },

        saveCachedQuarkCookie(cookie) {
            GM_setValue("guangya_quark_cookie", cookie);
        },

        decodeMd5(md5) {
            const s = (md5 == null ? "" : String(md5)).trim();
            if (!s) return "";
            if (/^[a-fA-F0-9]{32}$/.test(s)) return s;
            try {
                const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
                const padLen = (4 - (normalized.length % 4)) % 4;
                const padded = normalized + "=".repeat(padLen);
                const binary = atob(padded);
                if (binary.length !== 16) return "";
                return Array.from(binary, (ch) =>
                    ch.charCodeAt(0).toString(16).padStart(2, "0"),
                ).join("");
            } catch {
                return "";
            }
        },

        formatSize(bytes) {
            const n = Number(bytes) || 0;
            if (n < 1024) return `${n} B`;
            const units = ["KB", "MB", "GB", "TB"];
            let value = n / 1024;
            let i = 0;
            while (value >= 1024 && i < units.length - 1) {
                value /= 1024;
                i++;
            }
            return `${value.toFixed(2)} ${units[i]}`;
        },

        normalizeFilePath(path) {
            const clean = (path || "").replace(/^\/+/, "");
            return `/${clean}`;
        },

        normalizeEtag(etag) {
            return (etag || "").trim();
        },

        showQuarkCookieInputDialog(onSave, currentCookie = "") {
            const existing = document.getElementById("guangya-quark-cookie-dialog");
            if (existing) existing.remove();
            const dialog = document.createElement("div");
            dialog.id = "guangya-quark-cookie-dialog";
            dialog.innerHTML = `
              <div style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.55);z-index:2147483647;display:flex;align-items:center;justify-content:center;">
                <div style="background:#fff;padding:28px;border-radius:10px;width:82%;max-width:780px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.2);">
                  <div style="font-size:17px;font-weight:700;margin-bottom:12px;">设置夸克网盘 Cookie</div>
                  <div style="font-size:13px;color:#666;margin-bottom:12px;">
                    打开浏览器开发者工具 (F12) → Network → 找任意夸克请求 → 复制完整 Cookie 值<br>
                    <strong>需包含：__puus、__pus、ctoken 等关键字段</strong>
                  </div>
                  <textarea id="guangya-quark-cookie-input"
                    placeholder="粘贴完整 Cookie 字符串，例如：ctoken=xxx; __puus=xxx; __pus=xxx; ..."
                    style="flex:1;min-height:180px;padding:10px;border:1px solid #d9d9d9;border-radius:6px;font-family:monospace;font-size:12px;resize:vertical;">${currentCookie}</textarea>
                  <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px;">
                    <button id="guangya-quark-cookie-save" style="padding:8px 22px;background:#ff9800;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">保存</button>
                    <button id="guangya-quark-cookie-cancel" style="padding:8px 22px;background:#e0e0e0;color:#333;border:none;border-radius:6px;cursor:pointer;">取消</button>
                  </div>
                </div>
              </div>`;
            document.body.appendChild(dialog);
            const cookieSaveBtn = document.getElementById("guangya-quark-cookie-save");
            const cookieCancelBtn = document.getElementById("guangya-quark-cookie-cancel");
            const cookieInput = document.getElementById("guangya-quark-cookie-input");
            if (cookieSaveBtn) {
                cookieSaveBtn.onclick = () => {
                    const cookie =
                        cookieInput && "value" in cookieInput
                            ? String(cookieInput.value).trim()
                            : "";
                    if (!cookie) {
                        alert("Cookie 不能为空");
                        return;
                    }
                    this.saveCachedQuarkCookie(cookie);
                    dialog.remove();
                    if (onSave) onSave(cookie);
                };
            }
            if (cookieCancelBtn) {
                cookieCancelBtn.onclick = () => {
                    dialog.remove();
                    if (onSave) onSave(null);
                };
            }
        },

        showLoadingDialog(title, msg = "") {
            const existing = document.getElementById("guangya-loading-dialog");
            if (existing) existing.remove();
            const dialog = document.createElement("div");
            dialog.id = "guangya-loading-dialog";
            dialog.innerHTML = `
              <div style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:2147483646;display:flex;align-items:center;justify-content:center;">
                <div style="background:#fff;padding:32px 36px;border-radius:10px;min-width:300px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.18);">
                  <div style="font-size:17px;font-weight:700;margin-bottom:10px;">${title}</div>
                  <div id="guangya-loading-msg" style="font-size:13px;color:#888;">${msg}</div>
                </div>
              </div>`;
            document.body.appendChild(dialog);
        },

        updateLoadingMsg(msg) {
            const el = document.getElementById("guangya-loading-msg");
            if (el) el.textContent = msg;
        },

        closeLoadingDialog() {
            const el = document.getElementById("guangya-loading-dialog");
            if (el) el.remove();
        },

        showResultDialog(jsonData, shareTitle = "") {
            const existing = document.getElementById("guangya-result-dialog");
            if (existing) existing.remove();
            let currentJson = jsonData;
            const jsonStr = JSON.stringify(jsonData, null, 2);
            const checkboxHtml = shareTitle ? `
              <div style="margin-bottom:14px;padding:10px 14px;background:#fff8f0;border-radius:6px;border:1px solid #ffe0b2;">
                <label style="display:flex;align-items:center;cursor:pointer;gap:8px;">
                  <input type="checkbox" id="guangya-commonpath-checkbox" style="width:15px;height:15px;cursor:pointer;">
                  <span style="font-size:13px;color:#333;">设置 commonPath 为分享标题：<strong>${shareTitle}</strong></span>
                </label>
              </div>` : "";
            const dialog = document.createElement("div");
            dialog.id = "guangya-result-dialog";
            dialog.innerHTML = `
              <div style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:2147483646;display:flex;align-items:center;justify-content:center;">
                <div style="background:#fff;padding:28px;border-radius:10px;width:82%;max-width:820px;max-height:84vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.2);">
                  <div style="font-size:17px;font-weight:700;margin-bottom:14px;">秒传 JSON 生成成功</div>
                  ${checkboxHtml}
                  <div style="flex:1;overflow:auto;background:#f7f7f7;padding:14px;border-radius:6px;font-family:monospace;font-size:12px;margin-bottom:14px;">
                    <pre id="guangya-json-preview" style="margin:0;white-space:pre-wrap;word-break:break-all;">${jsonStr}</pre>
                  </div>
                  <div style="display:flex;gap:10px;justify-content:flex-end;">
                    <button id="guangya-result-copy" style="padding:8px 20px;background:#ff9800;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">复制 JSON</button>
                    <button id="guangya-result-download" style="padding:8px 20px;background:#4caf50;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">下载文件</button>
                    <button id="guangya-result-close" style="padding:8px 20px;background:#e0e0e0;color:#333;border:none;border-radius:6px;cursor:pointer;">关闭</button>
                  </div>
                </div>
              </div>`;
            document.body.appendChild(dialog);

            const getJsonStr = () => JSON.stringify(currentJson, null, 2);

            if (shareTitle) {
                const commonPathCb = document.getElementById(
                    "guangya-commonpath-checkbox",
                );
                if (commonPathCb && "checked" in commonPathCb) {
                    commonPathCb.onchange = () => {
                        currentJson = Object.assign({}, jsonData, {
                            commonPath: commonPathCb.checked
                                ? shareTitle + "/"
                                : "",
                        });
                        const pre = document.getElementById("guangya-json-preview");
                        if (pre) pre.textContent = getJsonStr();
                    };
                }
            }

            const resultCopyBtn = document.getElementById("guangya-result-copy");
            if (resultCopyBtn) {
                resultCopyBtn.onclick = () => {
                    GM_setClipboard(getJsonStr());
                    resultCopyBtn.textContent = "已复制!";
                    setTimeout(() => {
                        resultCopyBtn.textContent = "复制 JSON";
                    }, 1500);
                };
            }

            const resultDlBtn = document.getElementById("guangya-result-download");
            if (resultDlBtn) {
                resultDlBtn.onclick = () => {
                    const text = getJsonStr();
                    const blob = new Blob([text], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = makeRapidTransferExportFilename();
                    a.click();
                    URL.revokeObjectURL(url);
                };
            }

            const resultCloseBtn = document.getElementById("guangya-result-close");
            if (resultCloseBtn) {
                resultCloseBtn.onclick = () => dialog.remove();
            }
        },

        makeJson(files) {
            const invalidPaths = [""];
            invalidPaths.length = 0;
            const normalizedRaw = files
                .filter((f) => f && f.path)
                .map((f) => {
                    const path = this.normalizeFilePath(f.path);
                    const etag = this.normalizeEtag(f.etag || "");
                    const hasEtag = etag.length > 0;
                    if (!hasEtag) {
                        invalidPaths.push(path);
                    }
                    return {
                        etag:
                            hasEtag
                                ? etag
                                : INVALID_ETAG_POLICY === "empty"
                                  ? ""
                                  : etag,
                        size: String(f.size ?? 0),
                        path,
                        __valid: hasEtag,
                    };
                });

            if (invalidPaths.length > 0 && INVALID_ETAG_POLICY === "error") {
                const preview = invalidPaths.slice(0, 8).join("\n");
                const more =
                    invalidPaths.length > 8
                        ? `\n... 另有 ${invalidPaths.length - 8} 个文件`
                        : "";
                throw new Error(
                    `发现 ${invalidPaths.length} 个文件的 etag 为空。\n请检查数据源或改为 empty 策略。\n${preview}${more}`,
                );
            }

            const normalized =
                INVALID_ETAG_POLICY === "skip"
                    ? normalizedRaw
                          .filter((f) => f.__valid)
                          .map(({ __valid, ...rest }) => rest)
                    : normalizedRaw.map(({ __valid, ...rest }) => rest);

            const totalSize = normalized.reduce(
                (sum, f) => sum + (Number(f.size) || 0),
                0,
            );
            return {
                scriptVersion: SCRIPT_VERSION,
                totalFilesCount: normalized.length,
                totalSize,
                formattedTotalSize: this.formatSize(totalSize),
                files: normalized,
            };
        },

        output(jsonData) {
            const text = JSON.stringify(jsonData, null, 2);
            GM_setClipboard(text);

            const okDownload = confirm(
                "JSON 已复制到剪贴板。\n点击“确定”下载 .json 文件，点击“取消”仅保留复制结果。",
            );
            if (okDownload) {
                const blob = new Blob([text], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = makeRapidTransferExportFilename();
                a.click();
                URL.revokeObjectURL(url);
            }
        },
    };

    function getQuarkFileListPropsFromDom(fileListDom) {
        if (!fileListDom) return null;
        const key = Object.keys(fileListDom).find(
            (k) =>
                k.startsWith("__reactFiber$") ||
                k.startsWith("__reactInternalInstance$") ||
                k.startsWith("__reactContainer$"),
        );
        if (!key) return null;
        const rootFiber = fileListDom[key];

        function scanTree(fiber, maxSteps) {
            const q = [fiber];
            let steps = 0;
            while (q.length && steps < maxSteps) {
                const cur = q.shift();
                steps++;
                if (!cur) continue;
                const mp = cur.memoizedProps || cur.pendingProps;
                if (
                    mp &&
                    Array.isArray(mp.list) &&
                    Object.prototype.hasOwnProperty.call(mp, "selectedRowKeys")
                ) {
                    return mp;
                }
                let ch = cur.child;
                while (ch) {
                    q.push(ch);
                    ch = ch.sibling;
                }
            }
            return null;
        }

        const fromTree = scanTree(rootFiber, 600);
        if (fromTree) return fromTree;

        let f = rootFiber;
        for (let i = 0; i < 80 && f; i++) {
            const mp = f.memoizedProps || f.pendingProps;
            if (
                mp &&
                Array.isArray(mp.list) &&
                Object.prototype.hasOwnProperty.call(mp, "selectedRowKeys")
            ) {
                return mp;
            }
            f = f.return;
        }

        try {
            const getCompFiber = (fib) => {
                let p = fib;
                while (p && typeof p.type === "string") p = p.return;
                return p;
            };
            const fiber = rootFiber;
            const reactObj = fiber._currentElement
                ? fiber._currentElement._owner?._instance
                : getCompFiber(fiber)?.stateNode;
            const props = reactObj?.props;
            if (props && Array.isArray(props.list)) return props;
        } catch {
            // ignore
        }
        return null;
    }

    /** 从 DOM 取 React 内部实例，读取 props */
    function findQuarkReactInstance(dom, traverseUp) {
        const reactKey = Object.keys(dom).find(
            (k) =>
                k.startsWith("__reactFiber$") ||
                k.startsWith("__reactInternalInstance$"),
        );
        if (!reactKey) return null;
        const domFiber = dom[reactKey];
        if (domFiber == null) return null;
        if (domFiber._currentElement) {
            let compFiber = domFiber._currentElement._owner;
            for (let i = 0; i < traverseUp; i++) {
                compFiber =
                    compFiber &&
                    compFiber._currentElement &&
                    compFiber._currentElement._owner;
            }
            return compFiber && compFiber._instance;
        }
        const GetCompFiber = (fiber) => {
            let parentFiber = fiber.return;
            while (parentFiber && typeof parentFiber.type === "string") {
                parentFiber = parentFiber.return;
            }
            return parentFiber;
        };
        let compFiber = GetCompFiber(domFiber);
        for (let i = 0; i < traverseUp; i++) {
            compFiber = compFiber && GetCompFiber(compFiber);
        }
        return (compFiber && (compFiber.stateNode || compFiber)) || null;
    }

    function getReactFiberFromDom(el) {
        if (!el || typeof el !== "object") return null;
        const key = Object.keys(el).find(
            (k) =>
                k.startsWith("__reactFiber$") ||
                k.startsWith("__reactInternalInstance$"),
        );
        return key ? el[key] : null;
    }

    /**
     * 深度遍历 React Fiber，读取 Ant Design Table 的选中项（含 rowSelection）。
     * 虚拟列表下 DOM 只能看到视口内勾选行，React 侧往往仍有完整 selectedRowKeys。
     */
    function scanFiberForAntdTableSelection(rootFiber, maxNodes) {
        const limit = maxNodes == null ? 12000 : maxNodes;
        if (!rootFiber) return null;
        const q = [rootFiber];
        let nodes = 0;
        /** @type {{ keys: string[]; unselectedKeys: string[] } | null} */
        let best = null;
        while (q.length && nodes < limit) {
            const cur = q.shift();
            nodes++;
            if (!cur) continue;
            const mp = cur.memoizedProps || cur.pendingProps;
            if (mp && typeof mp === "object") {
                let keys = null;
                let unselected = null;
                if (Array.isArray(mp.selectedRowKeys)) {
                    keys = mp.selectedRowKeys;
                    unselected = mp.unselectedRowKeys;
                }
                const rs = mp.rowSelection;
                if ((!keys || !keys.length) && rs && typeof rs === "object") {
                    if (Array.isArray(rs.selectedRowKeys)) {
                        keys = rs.selectedRowKeys;
                        unselected = rs.unselectedRowKeys;
                    }
                }
                if (Array.isArray(keys) && keys.length) {
                    const ks = keys
                        .map((k) => String(k == null ? "" : k).trim())
                        .filter(Boolean);
                    if (ks.length) {
                        const us = Array.isArray(unselected)
                            ? unselected
                                  .map((k) => String(k == null ? "" : k).trim())
                                  .filter(Boolean)
                            : [];
                        if (!best || ks.length > best.keys.length) {
                            best = { keys: ks, unselectedKeys: us };
                        }
                    }
                }
            }
            let ch = cur.child;
            while (ch) {
                q.push(ch);
                ch = ch.sibling;
            }
        }
        return best;
    }

    function pan123ParseUiSelectionCount() {
        const t = String(document.body?.innerText || "");
        const m = t.match(/已选择\s*(\d+)\s*项/);
        if (!m) return null;
        const n = Number(m[1]);
        return Number.isFinite(n) ? n : null;
    }

    /** 勾选状态追踪 */
    class TableRowSelector123 {
        selectedRowKeys = [""];
        unselectedRowKeys = [""];
        isSelectAll = false;
        _inited = false;
        observer;
        originalCreateElement;

        init() {
            if (this._inited) return;
            this._inited = true;
            const originalCreateElement = document.createElement.bind(document);
            this.originalCreateElement = originalCreateElement;
            const self = this;
            document.createElement = function (tagName, options) {
                const element = originalCreateElement(tagName, options);
                if (tagName.toLowerCase() !== "input") return element;
                const mo = new MutationObserver(() => {
                    if (element.classList.contains("ant-checkbox-input")) {
                        if (element.getAttribute("aria-label") === "Select all") {
                            self.unselectedRowKeys = [];
                            self.selectedRowKeys = [];
                            self.isSelectAll = false;
                            self._bindSelectAllEvent(element);
                        } else {
                            const input = element;
                            input.addEventListener("click", function () {
                                const row = input.closest(".ant-table-row");
                                const rowKey = row?.getAttribute("data-row-key");
                                if (!rowKey) return;
                                if (self.isSelectAll) {
                                    if (!this.checked) {
                                        if (!self.unselectedRowKeys.includes(rowKey)) {
                                            self.unselectedRowKeys.push(rowKey);
                                        }
                                    } else {
                                        const idx = self.unselectedRowKeys.indexOf(rowKey);
                                        if (idx > -1) self.unselectedRowKeys.splice(idx, 1);
                                    }
                                } else if (this.checked) {
                                    if (!self.selectedRowKeys.includes(rowKey)) {
                                        self.selectedRowKeys.push(rowKey);
                                    }
                                } else {
                                    const idx = self.selectedRowKeys.indexOf(rowKey);
                                    if (idx > -1) self.selectedRowKeys.splice(idx, 1);
                                }
                            });
                        }
                    }
                    mo.disconnect();
                });
                mo.observe(element, {
                    attributes: true,
                    attributeFilter: ["class", "aria-label"],
                });
                return element;
            };
        }

        _bindSelectAllEvent(checkbox) {
            const targetElement = checkbox.parentElement;
            if (!targetElement) return;
            const self = this;
            this.observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (m.type === "attributes" && m.attributeName === "class") {
                        onClassChanged(targetElement);
                    }
                }
            });
            this.observer.observe(targetElement, {
                attributes: true,
                attributeOldValue: true,
                attributeFilter: ["class"],
            });
            function onClassChanged(el) {
                if (el.classList.contains("ant-checkbox-indeterminate")) return;
                if (el.classList.contains("ant-checkbox-checked")) {
                    self.isSelectAll = true;
                    self.unselectedRowKeys = [];
                    self.selectedRowKeys = [];
                } else {
                    self.isSelectAll = false;
                    self.selectedRowKeys = [];
                    self.unselectedRowKeys = [];
                }
            }
        }

        _syncFromDomFallback() {
            const rowInputs = Array.from(
                document.querySelectorAll(
                    ".ant-table-body input[type='checkbox'], .ant-table-tbody input[type='checkbox'], [class*='list'] input[type='checkbox'], [class*='table'] input[type='checkbox']",
                ),
            );
            if (!rowInputs.length) {
                const hasAnyChecked = !!document.querySelector(
                    ".ant-table-body input[type='checkbox']:checked, .ant-table-tbody input[type='checkbox']:checked, [class*='list'] input[type='checkbox']:checked, [class*='table'] input[type='checkbox']:checked, [role='checkbox'][aria-checked='true']",
                );
                if (!hasAnyChecked) {
                    this.isSelectAll = false;
                    this.selectedRowKeys = [];
                    this.unselectedRowKeys = [];
                }
                return;
            }

            const checkedKeys = [""];
            checkedKeys.length = 0;
            const uncheckedKeys = [""];
            uncheckedKeys.length = 0;
            const readRowKey = (input) => {
                const row =
                    input.closest("[data-row-key]") ||
                    input.closest("[data-file-id]") ||
                    input.closest("[data-fileid]") ||
                    input.closest("[data-id]") ||
                    input.closest("[data-key]") ||
                    input.closest("tr") ||
                    input.closest("li") ||
                    input.closest("[class*='row']") ||
                    input.closest("[class*='item']");
                if (!row) return "";
                const attrs = [
                    "data-row-key",
                    "data-file-id",
                    "data-fileid",
                    "data-id",
                    "data-key",
                    "row-key",
                ];
                for (const a of attrs) {
                    const v = String(row.getAttribute(a) || "").trim();
                    if (v) return v;
                }
                return "";
            };

            for (const input of rowInputs) {
                if (input.closest("thead")) continue;
                const rowKey = readRowKey(input);
                if (!rowKey) continue;
                if (input.checked) checkedKeys.push(rowKey);
                else uncheckedKeys.push(rowKey);
            }

            const headerChecked =
                !!document.querySelector(
                    ".ant-table-header .ant-checkbox-wrapper .ant-checkbox-checked, thead .ant-checkbox-wrapper .ant-checkbox-checked",
                ) ||
                !!document.querySelector(
                    ".ant-table-header .ant-checkbox-input:checked, thead .ant-checkbox-input:checked, .ant-table-header input[type='checkbox']:checked, thead input[type='checkbox']:checked",
                );

            if (headerChecked) {
                this.isSelectAll = true;
                this.selectedRowKeys = [];
                this.unselectedRowKeys = uncheckedKeys;
                return;
            }

            this.isSelectAll = false;
            this.selectedRowKeys = checkedKeys;
            this.unselectedRowKeys = [];
        }

        _syncFromReactFallback() {
            const selectors = [
                ".ant-table-wrapper",
                ".ant-table",
                "[class*='table']",
                "[class*='list']",
                "[class*='file']",
            ];
            const checkedCount = document.querySelectorAll(
                ".ant-table-body input[type='checkbox']:checked, .ant-table-tbody input[type='checkbox']:checked, [class*='list'] input[type='checkbox']:checked, [class*='table'] input[type='checkbox']:checked, [role='checkbox'][aria-checked='true']",
            ).length;
            for (const s of selectors) {
                const nodes = document.querySelectorAll(s);
                for (const dom of nodes) {
                    let props = getQuarkFileListPropsFromDom(dom);
                    if (!props) {
                        for (let up = 0; up < 10; up++) {
                            const reactObj = findQuarkReactInstance(dom, up);
                            const p = reactObj && reactObj.props;
                            if (!p) continue;
                            if (Array.isArray(p.selectedRowKeys)) {
                                props = p;
                                break;
                            }
                        }
                    }
                    const rawKeys =
                        props &&
                        (Array.isArray(props.selectedRowKeys)
                            ? props.selectedRowKeys
                            : Array.isArray(props.selectedKeys)
                              ? props.selectedKeys
                              : null);
                    if (!rawKeys || rawKeys.length === 0) continue;
                    const keys = rawKeys
                        .map((k) => String(k == null ? "" : k).trim())
                        .filter(Boolean);
                    if (!keys.length) continue;
                    this.isSelectAll = false;
                    this.selectedRowKeys = keys;
                    this.unselectedRowKeys = [];
                    return;
                }
            }
            if (checkedCount > 0 && this.selectedRowKeys.length === 0 && !this.isSelectAll) {
                // 有勾选但未拿到 row key：保留原状态，交由上层提示用户/继续兜底。
            }
        }

        _pickTextFromRow(row) {
            if (!row) return "";
            const candidates = row.querySelectorAll(
                "[title], [data-title], [data-name], .file-name, .name, a, span, div",
            );
            for (const el of candidates) {
                const t1 = String(el.getAttribute?.("title") || "").trim();
                if (t1 && t1.length <= 300) return t1;
                const t2 = String(el.getAttribute?.("data-name") || "").trim();
                if (t2 && t2.length <= 300) return t2;
                const t3 = String(el.textContent || "").trim();
                if (
                    t3 &&
                    t3.length <= 300 &&
                    !/^(\d+(\.\d+)?\s*(kb|mb|gb|tb)|\d{4}-\d{1,2}-\d{1,2})$/i.test(t3)
                ) {
                    return t3;
                }
            }
            return "";
        }

        _getRowKeyFromRow(row) {
            if (!row) return "";
            const attrs = [
                "data-row-key",
                "data-file-id",
                "data-fileid",
                "data-id",
                "data-key",
                "row-key",
                "file-id",
            ];
            for (const a of attrs) {
                const v = String(row.getAttribute?.(a) || "").trim();
                if (v) return v;
            }
            return "";
        }

        _collectSelectedRows() {
            const rows = new Set();
            const collectRow = (node) => {
                if (!node || !node.closest) return;
                if (node.closest("thead")) return;
                const row =
                    node.closest("[data-row-key]") ||
                    node.closest("[data-file-id]") ||
                    node.closest("[data-fileid]") ||
                    node.closest("[data-id]") ||
                    node.closest("[data-key]") ||
                    node.closest("tr") ||
                    node.closest("li") ||
                    node.closest("[class*='row']") ||
                    node.closest("[class*='item']");
                if (!row || row.closest("thead")) return;
                rows.add(row);
            };

            const checked = document.querySelectorAll(
                ".ant-table-body input[type='checkbox']:checked, .ant-table-tbody input[type='checkbox']:checked, [class*='list'] input[type='checkbox']:checked, [class*='table'] input[type='checkbox']:checked, [role='checkbox'][aria-checked='true']",
            );
            for (const el of checked) collectRow(el);

            const selectedRows = document.querySelectorAll(
                ".ant-table-row-selected, [aria-selected='true'], [class*='row'][class*='selected'], [class*='item'][class*='selected']",
            );
            for (const el of selectedRows) collectRow(el);

            return [...rows];
        }

        getSelectedNameHints() {
            const names = new Set();
            const rows = this._collectSelectedRows();
            for (const row of rows) {
                const name = this._pickTextFromRow(row);
                if (name) names.add(name);
            }
            return [...names];
        }

        getSelectedRowKeyHints() {
            const keys = new Set();
            const rows = this._collectSelectedRows();
            for (const row of rows) {
                const k = this._getRowKeyFromRow(row);
                if (k) keys.add(k);
            }
            return [...keys];
        }

        _scanBestReactTableSelection() {
            const roots = document.querySelectorAll(
                ".ant-table-wrapper, .ant-table, [class*='ant-table']",
            );
            /** @type {{ keys: string[]; unselectedKeys: string[] } | null} */
            let best = null;
            for (let i = 0; i < roots.length; i++) {
                const fiber = getReactFiberFromDom(roots[i]);
                if (!fiber) continue;
                const hit = scanFiberForAntdTableSelection(fiber, 12000);
                if (hit && (!best || hit.keys.length > best.keys.length)) {
                    best = hit;
                }
            }
            const appRoot =
                document.getElementById("root") ||
                document.getElementById("app") ||
                document.body;
            const rf = getReactFiberFromDom(appRoot);
            if (rf) {
                const hit = scanFiberForAntdTableSelection(rf, 16000);
                if (hit && (!best || hit.keys.length > best.keys.length)) {
                    best = hit;
                }
            }
            return best;
        }

        getSelection() {
            this._syncFromDomFallback();
            const domIsAll = this.isSelectAll;
            const domKeys = [...this.selectedRowKeys];
            const domUnselected = [...this.unselectedRowKeys];

            const reactSel = this._scanBestReactTableSelection();

            if (domIsAll) {
                if (
                    reactSel &&
                    reactSel.unselectedKeys &&
                    reactSel.unselectedKeys.length > domUnselected.length
                ) {
                    this.unselectedRowKeys = [...reactSel.unselectedKeys];
                }
                return {
                    isSelectAll: true,
                    selectedRowKeys: [],
                    unselectedRowKeys: [...this.unselectedRowKeys],
                };
            }

            if (reactSel && reactSel.keys.length) {
                const merged = Array.from(
                    new Set(
                        [...reactSel.keys, ...domKeys].map((k) => String(k).trim()),
                    ),
                ).filter(Boolean);
                this.selectedRowKeys = merged;
                this.unselectedRowKeys = [];
                this.isSelectAll = false;
            } else if (!this.isSelectAll && this.selectedRowKeys.length === 0) {
                this._syncFromReactFallback();
            }

            const uiN = pan123ParseUiSelectionCount();
            if (
                uiN != null &&
                !this.isSelectAll &&
                this.selectedRowKeys.length > 0 &&
                this.selectedRowKeys.length < uiN
            ) {
                try {
                    console.warn(
                        `[秒传工具][123] 页面显示已选择 ${uiN} 项，但只解析到 ${this.selectedRowKeys.length} 个文件 ID。可尝试滚动列表让选中行进入视口后重试，或刷新页面。`,
                    );
                } catch {
                    /* ignore */
                }
            }

            return {
                isSelectAll: this.isSelectAll,
                selectedRowKeys: [...this.selectedRowKeys],
                unselectedRowKeys: [...this.unselectedRowKeys],
            };
        }
    }

    function pan123PickInfoList(data) {
        if (!data || typeof data !== "object") return [];
        return data.InfoList || data.infoList || data.file_infos || data.fileInfos || [];
    }

    class Pan123Api {
        host = "";
        referer = "";

        refresh() {
            this.host = `${location.protocol}//${location.host}`;
            this.referer = document.location.href;
        }

        get authToken() {
            return localStorage.getItem("authorToken") || "";
        }

        get loginUuid() {
            return localStorage.getItem("LoginUuid") || "";
        }

        async sendRequest(method, path, queryParams, body) {
            this.refresh();
            const qs = new URLSearchParams(queryParams).toString();
            const url = `${this.host}${path}?${qs}`;
            const headers = {
                "Content-Type": "application/json;charset=UTF-8",
                Authorization: `Bearer ${this.authToken}`,
                platform: "web",
                "App-Version": "3",
                LoginUuid: this.loginUuid,
                Origin: this.host,
                Referer: this.referer,
            };
            /** @type {RequestInit & { body?: any }} */
            const init = {
                method,
                headers,
                credentials: "include",
            };
            if (method !== "GET" && method !== "HEAD" && body != null) {
                init.body = body;
            }
            const res = await fetch(url, init);
            const data = await res.json();
            if (data.code !== 0) {
                throw new Error(data.message || `123云盘 API 错误: ${data.code}`);
            }
            return data;
        }

        async getParentFileId() {
            const raw = sessionStorage.getItem("filePath");
            if (!raw) {
                throw new Error(
                    "无法获取当前目录，请在 123 云盘「我的文件」列表页使用",
                );
            }
            const homeFilePath = JSON.parse(raw).homeFilePath;
            const parent = homeFilePath[homeFilePath.length - 1] ?? 0;
            return String(parent);
        }

        async getOnePageFileList(parentFileId, page) {
            const urlParams = {
                driveId: "0",
                limit: "100",
                next: "0",
                orderBy: "file_name",
                orderDirection: "asc",
                parentFileId: String(parentFileId),
                trashed: "false",
                SearchData: "",
                Page: String(page),
                OnlyLookAbnormalFile: "0",
                event: "homeListFile",
                operateType: "1",
                inDirectSpace: "false",
            };
            return this.sendRequest("GET", "/b/api/file/list/new", urlParams, "");
        }

        async getFileList(parentFileId) {
            let infoList = [];
            const first = await this.getOnePageFileList(parentFileId, 1);
            infoList = infoList.concat(pan123PickInfoList(first.data));
            const totalRaw =
                first.data?.Total ??
                first.data?.total ??
                first.data?.count ??
                infoList.length;
            const total = Number.isFinite(Number(totalRaw))
                ? Number(totalRaw)
                : infoList.length;
            if (total > 100) {
                const times = Math.ceil(total / 100);
                for (let i = 2; i <= times; i++) {
                    await helper.sleep(500);
                    const page = await this.getOnePageFileList(parentFileId, i);
                    infoList = infoList.concat(pan123PickInfoList(page.data));
                }
            }
            return { data: { InfoList: infoList, total } };
        }

        async getFileInfoBatch(idList) {
            const batchSize = 100;
            const rows = [];
            for (let i = 0; i < idList.length; i += batchSize) {
                const batch = idList.slice(i, i + batchSize);
                const fileIdList = batch.map((fileId) => ({ fileId }));
                const data = await this.sendRequest(
                    "POST",
                    "/b/api/file/info",
                    {},
                    JSON.stringify({ fileIdList }),
                );
                const list = pan123PickInfoList(data.data);
                for (const file of list) {
                    rows.push(pan123NormalizeFileInfo(file));
                }
                await helper.sleep(200);
            }
            return rows;
        }
    }

    const pan123Selector = new TableRowSelector123();
    const pan123Api = new Pan123Api();
    const pan123GetEtagLike = (file) => {
        const raw =
            file?.Etag ??
            file?.etag ??
            file?.md5 ??
            file?.MD5 ??
            file?.Md5 ??
            file?.fileMd5 ??
            file?.FileMd5 ??
            file?.hash ??
            "";
        return String(raw || "").trim();
    };
    const pan123NormalizeFileInfo = (file) => {
        const fileName = String(file?.FileName ?? file?.file_name ?? file?.name ?? "").trim();
        const sizeRaw = file?.Size ?? file?.size ?? 0;
        const typeRaw = file?.Type ?? file?.type ?? file?.file_type ?? 0;
        const fileId = file?.FileId ?? file?.fileId ?? file?.file_id ?? "";
        const size = Number.isFinite(Number(sizeRaw)) ? Number(sizeRaw) : 0;
        const type = Number.isFinite(Number(typeRaw)) ? Number(typeRaw) : 0;
        return {
            fileName,
            etag: pan123GetEtagLike(file),
            size,
            type,
            fileId,
        };
    };

    const pan123 = {
        initSelector() {
            pan123Selector.init();
        },

        is123Host() {
            return /(^|\.)123pan\.(com|cn)$/i.test(location.hostname);
        },

        async collectFiles() {
            const sel = pan123Selector.getSelection();
            const selectedRowKeyHints = sel.isSelectAll
                ? []
                : pan123Selector.getSelectedRowKeyHints();
            const selectedNameHints =
                !sel.isSelectAll && sel.selectedRowKeys.length === 0
                    ? pan123Selector.getSelectedNameHints()
                    : [];
            if (
                !sel.isSelectAll &&
                sel.selectedRowKeys.length === 0 &&
                selectedRowKeyHints.length === 0 &&
                selectedNameHints.length === 0
            ) {
                throw new Error("请先在 123 云盘勾选要导出的文件或文件夹");
            }

            const fileInfoList = [];
            let folderRows = [];

            if (sel.isSelectAll) {
                const parentId = await pan123Api.getParentFileId();
                const { data } = await pan123Api.getFileList(parentId);
                const mapped = (data.InfoList || []).map((file) =>
                    pan123NormalizeFileInfo(file),
                );
                const files = mapped.filter((f) => f.type !== 1);
                files
                    .filter(
                        (f) =>
                            !sel.unselectedRowKeys.includes(f.fileId.toString()),
                    )
                    .forEach((f) => {
                        fileInfoList.push({ ...f, path: f.fileName });
                    });
                folderRows = mapped
                    .filter((f) => f.type === 1)
                    .filter(
                        (f) =>
                            !sel.unselectedRowKeys.includes(f.fileId.toString()),
                    );
            } else {
                const selectedKeys = Array.from(
                    new Set(
                        [...sel.selectedRowKeys, ...selectedRowKeyHints].map((k) =>
                            String(k == null ? "" : k).trim(),
                        ),
                    ),
                ).filter(Boolean);
                if (selectedKeys.length > 0) {
                    const allFileInfo = await pan123Api.getFileInfoBatch(
                        selectedKeys,
                    );
                    allFileInfo
                        .filter((info) => info.type !== 1)
                        .forEach((f) => {
                            fileInfoList.push({ ...f, path: f.fileName });
                        });
                    folderRows = allFileInfo.filter((info) => info.type === 1);
                } else {
                    // 兜底：部分新页面拿不到 row key，但可从已勾选行文本匹配当前目录项。
                    const parentId = await pan123Api.getParentFileId();
                    const { data } = await pan123Api.getFileList(parentId);
                    const mapped = (data.InfoList || []).map((file) =>
                        pan123NormalizeFileInfo(file),
                    );
                    const nameSet = new Set(selectedNameHints);
                    const picked = mapped.filter((f) => nameSet.has(f.fileName));
                    picked
                        .filter((info) => info.type !== 1)
                        .forEach((f) => {
                            fileInfoList.push({ ...f, path: f.fileName });
                        });
                    folderRows = picked.filter((info) => info.type === 1);
                }
            }

            const walkFolder = async (parentFileId, prefix) => {
                const { data } = await pan123Api.getFileList(parentFileId);
                const mapped = (data.InfoList || []).map((file) =>
                    pan123NormalizeFileInfo(file),
                );
                mapped
                    .filter((f) => f.type !== 1)
                    .forEach((f) => {
                        fileInfoList.push({
                            ...f,
                            path: prefix + f.fileName,
                        });
                    });
                const dirs = mapped.filter((f) => f.type === 1);
                for (const folder of dirs) {
                    await helper.sleep(300);
                    await walkFolder(
                        folder.fileId,
                        `${prefix}${folder.fileName}/`,
                    );
                }
            };

            for (const folder of folderRows) {
                await helper.sleep(300);
                await walkFolder(folder.fileId, `${folder.fileName}/`);
            }

            if (!fileInfoList.length) {
                throw new Error("没有可导出的文件（文件夹内为空或未选中文）");
            }

            return fileInfoList.map((f) => ({
                path: f.path || f.fileName,
                etag: String(f.etag || ""),
                size: Number(f.size || 0),
            }));
        },
    };

    const quark = {
        /** 当前目录面包屑 */
        getCurrentPath() {
            try {
                const urlParams = new URLSearchParams(window.location.search);
                const dirFid = urlParams.get("dir_fid");
                if (!dirFid || dirFid === "0") {
                    return "";
                }
                const breadcrumb = document.querySelector(".breadcrumb-list");
                if (breadcrumb) {
                    const items = breadcrumb.querySelectorAll(".breadcrumb-item");
                    const pathParts = [""];
                    pathParts.length = 0;
                    for (let i = 1; i < items.length; i++) {
                        const text = items[i].textContent.trim();
                        if (text) pathParts.push(text);
                    }
                    return pathParts.join("/");
                }
                return "";
            } catch (e) {
                return "";
            }
        },

        getSelectedList() {
            const isSharePath = /^\/(s|share)\//.test(location.pathname);
            try {
                if (typeof unsafeWindow !== "undefined") {
                    const apiList = isSharePath
                        ? unsafeWindow.shareUser?.getSelectedFileList?.()
                        : unsafeWindow.file?.getSelectedFileList?.();
                    if (Array.isArray(apiList) && apiList.length) {
                        return apiList;
                    }
                }
            } catch {
                /* ignore */
            }
            const a = document.getElementsByClassName("file-list")[0];
            const b = document.querySelector(".file-list");
            const c = document.querySelector("[class*='file-list']");
            const candidates = [a, b, c].filter((el, i, arr) => {
                if (!el) return false;
                if (i === 1) return el !== arr[0];
                if (i === 2) return el !== arr[0] && el !== arr[1];
                return true;
            });
            for (const fileListDom of candidates) {
                let props = getQuarkFileListPropsFromDom(fileListDom);
                if (!props) {
                    for (let up = 0; up < 10; up++) {
                        const reactObj = findQuarkReactInstance(fileListDom, up);
                        const p = reactObj && reactObj.props;
                        if (
                            p &&
                            Array.isArray(p.list) &&
                            p.selectedRowKeys !== undefined
                        ) {
                            props = p;
                            break;
                        }
                    }
                }
                if (props && Array.isArray(props.list)) {
                    const list = props.list || [];
                    const selectedKeys = props.selectedRowKeys || [];
                    return list.filter((it) => selectedKeys.includes(it.fid));
                }
            }
            return [];
        },

        async getFolderFiles(folderId, folderPath = "") {
            const files = [];
            let page = 1;
            const size = 50;
            while (true) {
                const url = `https://drive-pc.quark.cn/1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=${folderId}&_page=${page}&_size=${size}&_fetch_total=1&_fetch_sub_dirs=0&_sort=file_type:asc,updated_at:desc`;
                const text = String(await helper.get(url));
                const result = JSON.parse(text);
                if (result?.code !== 0 || !Array.isArray(result?.data?.list)) break;
                const list = result.data.list || [];
                for (const item of list) {
                    const path = folderPath
                        ? `${folderPath}/${item.file_name}`
                        : item.file_name;
                    if (item.dir) {
                        files.push(...(await this.getFolderFiles(item.fid, path)));
                    } else if (item.file) {
                        files.push({ ...item, path });
                    }
                }
                if (list.length < size) break;
                page++;
            }
            return files;
        },

        async getHomeFiles() {
            const selected = this.getSelectedList();
            if (!selected.length) throw new Error("请先勾选夸克文件/文件夹");
            const currentPath = this.getCurrentPath();
            const all = [];
            for (const item of selected) {
                if (item.file) {
                    const filePath = currentPath
                        ? `${currentPath}/${item.file_name}`
                        : item.file_name;
                    all.push({ ...item, path: filePath });
                } else if (item.dir) {
                    const folderPath = currentPath
                        ? `${currentPath}/${item.file_name}`
                        : item.file_name;
                    all.push(...(await this.getFolderFiles(item.fid, folderPath)));
                }
            }
            if (!all.length) throw new Error("未找到可导出的夸克文件");

            const fileOnly = all.filter((f) => f.file === true);

            /** @type {Record<string, string>} */
            const pathMap = {};
            fileOnly.forEach((f) => (pathMap[f.fid] = f.path || f.file_name));

            /** @type {{ path: string; etag: string; size: number }[]} */
            const output = [];

            const needFetch = [];
            for (const f of fileOnly) {
                const rawEtag = f.etag || f.md5 || f.hash || "";
                const s = (rawEtag || "").toString().trim();
                if (s) {
                    const dec = helper.decodeMd5(s);
                    output.push({
                        path: pathMap[f.fid] || f.file_name,
                        etag: (dec || s).toLowerCase(),
                        size: Number(f.size || 0),
                    });
                } else {
                    needFetch.push(f);
                }
            }

            const batchSize = 15;
            for (let i = 0; i < needFetch.length; i += batchSize) {
                const batch = needFetch.slice(i, i + batchSize);
                const fids = batch.map((b) => b.fid);
                let resp;
                try {
                    resp = await helper.postQuarkPcJson(
                        "https://drive.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc",
                        { fids },
                    );
                } catch {
                    continue;
                }
                if (resp && resp.code === 31001) throw new Error("夸克账号未登录");
                if (!resp || resp.code !== 0) {
                    continue;
                }
                for (const f of resp.data || []) {
                    const raw = String(f.md5 || f.hash || f.etag || "").trim();
                    const decoded = helper.decodeMd5(raw);
                    const etagOut = (decoded || raw).toLowerCase();
                    if (!etagOut) {
                        continue;
                    }
                    output.push({
                        path: pathMap[f.fid] || f.file_name,
                        etag: etagOut,
                        size: Number(f.size || 0),
                    });
                }
                await helper.sleep(1000);
            }
            if (!output.length) {
                throw new Error(
                    "未能得到任何文件的 etag：列表与 download 接口均无 md5/etag。请确认已登录 pan.quark.cn / drive.quark.cn，并勾选需导出的文件后重试。",
                );
            }
            return output;
        },

        async getShareToken(shareId, cookie) {
            const resp = /** @type {any} */ (await helper.postJson(
                "https://pc-api.uc.cn/1/clouddrive/share/sharepage/token",
                { pwd_id: shareId, passcode: "" },
                {
                    Cookie: cookie,
                    Referer: "https://pan.quark.cn/",
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
                },
            ));
            if (resp?.code === 31001)
                throw new Error("夸克分享页 Cookie 无效，请重新输入");
            if (resp?.code !== 0 || !resp?.data?.stoken) {
                throw new Error(`夸克分享 token 获取失败：${resp?.message || resp?.code}`);
            }
            return { stoken: resp.data.stoken, title: resp.data.title || "" };
        },

        async scanShareFiles(
            shareId,
            stoken,
            cookie,
            parentFid,
            path = "",
            recursive = true,
        ) {
            const result = [];
            let page = 1;
            while (true) {
                const url = `https://pc-api.uc.cn/1/clouddrive/share/sharepage/detail?pwd_id=${shareId}&stoken=${encodeURIComponent(
                    stoken,
                )}&pdir_fid=${parentFid}&_page=${page}&_size=100&pr=ucpro&fr=pc`;
                const text = String(
                    await helper.get(url, {
                        Cookie: cookie,
                        Referer: "https://pan.quark.cn/",
                        "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0",
                    }),
                );
                const data = JSON.parse(text);
                if (data?.code !== 0 || !Array.isArray(data?.data?.list)) break;
                const list = data.data.list || [];
                for (const item of list) {
                    const itemPath = path ? `${path}/${item.file_name}` : item.file_name;
                    if (item.dir) {
                        if (recursive) {
                            result.push(
                                ...(await this.scanShareFiles(
                                    shareId,
                                    stoken,
                                    cookie,
                                    item.fid,
                                    itemPath,
                                    true,
                                )),
                            );
                        }
                    } else if (item.file) {
                        result.push({
                            fid: item.fid,
                            token: item.share_fid_token,
                            size: Number(item.size || 0),
                            path: itemPath,
                        });
                    }
                }
                if (list.length < 100) break;
                page++;
            }
            return result;
        },

        async getShareMd5Map(shareId, stoken, cookie, fileItems) {
            /** @type {Record<string, string>} */
            const md5Map = {};
            const batchSize = 10;
            for (let i = 0; i < fileItems.length; i += batchSize) {
                const batch = fileItems.slice(i, i + batchSize);
                const fids = batch.map((b) => b.fid);
                const fidsToken = batch.map((b) => b.token);
                const resp = /** @type {any} */ (await helper.postJson(
                    `https://pc-api.uc.cn/1/clouddrive/file/download?pr=ucpro&fr=pc&uc_param_str=&__dt=${Math.floor(Math.random() * 4 + 1) * 60 * 1000}&__t=${Date.now()}`,
                    { fids, pwd_id: shareId, stoken, fids_token: fidsToken },
                    {
                        Cookie: cookie,
                        Referer: "https://pan.quark.cn/",
                        Origin: "https://pan.quark.cn",
                        "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.14.2 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch",
                        Accept: "application/json, text/plain, */*",
                    },
                ));
                if (resp?.code === 0 && resp?.data) {
                    const arr = Array.isArray(resp.data) ? resp.data : [resp.data];
                    arr.forEach((it, idx) => {
                        const fid = fids[idx];
                        const raw = String(it.md5 || it.hash || it.etag || "").trim();
                        const dec = helper.decodeMd5(raw);
                        md5Map[fid] = dec || raw;
                    });
                } else {
                    fids.forEach((fid) => (md5Map[fid] = ""));
                }
                await helper.sleep(700);
            }
            return md5Map;
        },

        async getShareFiles() {
            const selected = this.getSelectedList();
            if (!selected.length) throw new Error("请先勾选夸克分享文件/文件夹");
            const m = location.pathname.match(/\/(s|share)\/([a-zA-Z0-9]+)/);
            if (!m) throw new Error("无法识别夸克分享ID");
            const shareId = m[2];

            let cookie = helper.getCachedQuarkCookie();
            if (!cookie || cookie.length < 8) {
                helper.closeLoadingDialog();
                cookie = await new Promise((resolve) => {
                    helper.showQuarkCookieInputDialog(resolve, helper.getCachedQuarkCookie());
                });
                if (!cookie) throw new Error("已取消输入 Cookie，操作中断");
                helper.showLoadingDialog("正在扫描分享文件", "请稍候...");
            }

            const { stoken, title } = await this.getShareToken(shareId, cookie);
            helper.updateLoadingMsg("正在扫描文件列表...");
            const fileItems = [];
            for (const item of selected) {
                if (item.file) {
                    const parentFid = item.pdir_fid;
                    const list = await this.scanShareFiles(
                        shareId,
                        stoken,
                        cookie,
                        parentFid,
                        "",
                        false,
                    );
                    const found = list.find((x) => x.fid === item.fid);
                    if (found) {
                        fileItems.push(found);
                    } else {
                        fileItems.push({
                            fid: item.fid,
                            token: item.share_fid_token,
                            size: Number(item.size || 0),
                            path: item.file_name,
                        });
                    }
                } else if (item.dir) {
                    fileItems.push(
                        ...(await this.scanShareFiles(
                            shareId,
                            stoken,
                            cookie,
                            item.fid,
                            item.file_name,
                            true,
                        )),
                    );
                }
            }
            if (!fileItems.length) throw new Error("未找到可导出的夸克分享文件");
            helper.updateLoadingMsg(`已扫描到 ${fileItems.length} 个文件，正在获取 MD5...`);
            const md5Map = await this.getShareMd5Map(shareId, stoken, cookie, fileItems);
            const rows = fileItems.map((f) => ({
                path: f.path,
                etag: (md5Map[f.fid] || "").trim(),
                size: Number(f.size || 0),
            }));
            const anyEtag = rows.some((r) => r.etag && r.etag.length > 0);
            if (!anyEtag) {
                const isCookieErr = true;
                throw new Error(
                    "分享页未能得到任何 etag：请检查 Cookie 是否有效，或稍后重试（接口限频时也会失败）。" +
                    (isCookieErr ? "\n\n可能是 Cookie 已过期，请点击按钮更新 Cookie 后重试。" : ""),
                );
            }
            return { files: rows, title };
        },
    };

    const tianyi = {
        /** 优先页面 API（unsafeWindow），再回退 DOM + __vue__。 */
        getSelectedFiles() {
            try {
                if (typeof unsafeWindow !== "undefined") {
                    let list;
                    if (/\/web\/share/.test(location.href)) {
                        list = unsafeWindow.shareUser?.getSelectedFileList?.();
                    } else {
                        list = unsafeWindow.file?.getSelectedFileList?.();
                    }
                    if (list && list.length > 0) return list;
                }
            } catch {
                // ignore
            }

            const selectedItems = [];
            let selectedElements = document.querySelectorAll("li.c-file-item-select");

            if (selectedElements.length === 0) {
                const checkedBoxes = document.querySelectorAll(".ant-checkbox-checked");
                if (checkedBoxes.length > 0) {
                    selectedElements = Array.from(checkedBoxes)
                        .map((box) => box.closest("li.c-file-item"))
                        .filter((el) => el);
                }
            }

            if (selectedElements.length === 0) return [];

            selectedElements.forEach((itemEl) => {
                if (itemEl.__vue__) {
                    const vueInstance = itemEl.__vue__;
                    const fileData =
                        vueInstance.fileItem ||
                        vueInstance.fileInfo ||
                        vueInstance.item ||
                        vueInstance.file;
                    if (fileData) {
                        const fid = fileData.id || fileData.fileId;
                        if (!selectedItems.some((item) => (item.id || item.fileId) === fid)) {
                            selectedItems.push({
                                id: fid,
                                fileId: fid,
                                name: fileData.name || fileData.fileName,
                                fileName: fileData.name || fileData.fileName,
                                isFolder: !!(fileData.isFolder || fileData.fileCata === 2),
                                fileCata: fileData.fileCata,
                                md5: fileData.md5,
                                size: fileData.size,
                            });
                        }
                    }
                }
            });
            return selectedItems;
        },

        sign(params) {
            const sorted = Object.keys(params)
                .sort()
                .map((k) => `${k}=${params[k]}`)
                .join("&");
            return this.md5(sorted);
        },

        md5(str) {
            function rotateLeft(v, s) {
                return (v << s) | (v >>> (32 - s));
            }
            function addUnsigned(x, y) {
                const lsw = (x & 0xffff) + (y & 0xffff);
                const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
                return (msw << 16) | (lsw & 0xffff);
            }
            function F(x, y, z) {
                return (x & y) | (~x & z);
            }
            function G(x, y, z) {
                return (x & z) | (y & ~z);
            }
            function H(x, y, z) {
                return x ^ y ^ z;
            }
            function I(x, y, z) {
                return y ^ (x | ~z);
            }
            function FF(a, b, c, d, x, s, ac) {
                a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac));
                return addUnsigned(rotateLeft(a, s), b);
            }
            function GG(a, b, c, d, x, s, ac) {
                a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac));
                return addUnsigned(rotateLeft(a, s), b);
            }
            function HH(a, b, c, d, x, s, ac) {
                a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac));
                return addUnsigned(rotateLeft(a, s), b);
            }
            function II(a, b, c, d, x, s, ac) {
                a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac));
                return addUnsigned(rotateLeft(a, s), b);
            }
            /** @param {string} s @returns {number[]} */
            function convertToWordArray(s) {
                const l = s.length;
                const words = [0];
                let i;
                for (i = 0; i < l - 3; i += 4) {
                    words.push(
                        s.charCodeAt(i) |
                            (s.charCodeAt(i + 1) << 8) |
                            (s.charCodeAt(i + 2) << 16) |
                            (s.charCodeAt(i + 3) << 24),
                    );
                }
                let val = 0;
                switch (l % 4) {
                    case 0:
                        val = 0x080000000;
                        break;
                    case 1:
                        val = s.charCodeAt(i) | 0x0800000;
                        break;
                    case 2:
                        val = s.charCodeAt(i) | (s.charCodeAt(i + 1) << 8) | 0x080000;
                        break;
                    default:
                        val =
                            s.charCodeAt(i) |
                            (s.charCodeAt(i + 1) << 8) |
                            (s.charCodeAt(i + 2) << 16) |
                            0x80;
                }
                words.push(val);
                while ((words.length % 16) !== 14) words.push(0);
                words.push(l << 3);
                words.push(l >>> 29);
                words.shift();
                return words;
            }
            function toHex(v) {
                let out = "";
                for (let i = 0; i <= 3; i++) {
                    out += ("0" + ((v >>> (i * 8)) & 255).toString(16)).slice(-2);
                }
                return out;
            }

            let a = 0x67452301;
            let b = 0xefcdab89;
            let c = 0x98badcfe;
            let d = 0x10325476;
            const x = convertToWordArray(unescape(encodeURIComponent(str)));
            const S11 = 7, S12 = 12, S13 = 17, S14 = 22;
            const S21 = 5, S22 = 9, S23 = 14, S24 = 20;
            const S31 = 4, S32 = 11, S33 = 16, S34 = 23;
            const S41 = 6, S42 = 10, S43 = 15, S44 = 21;
            for (let k = 0; k < x.length; k += 16) {
                const AA = a, BB = b, CC = c, DD = d;
                a = FF(a, b, c, d, x[k + 0], S11, 0xd76aa478);
                d = FF(d, a, b, c, x[k + 1], S12, 0xe8c7b756);
                c = FF(c, d, a, b, x[k + 2], S13, 0x242070db);
                b = FF(b, c, d, a, x[k + 3], S14, 0xc1bdceee);
                a = FF(a, b, c, d, x[k + 4], S11, 0xf57c0faf);
                d = FF(d, a, b, c, x[k + 5], S12, 0x4787c62a);
                c = FF(c, d, a, b, x[k + 6], S13, 0xa8304613);
                b = FF(b, c, d, a, x[k + 7], S14, 0xfd469501);
                a = FF(a, b, c, d, x[k + 8], S11, 0x698098d8);
                d = FF(d, a, b, c, x[k + 9], S12, 0x8b44f7af);
                c = FF(c, d, a, b, x[k + 10], S13, 0xffff5bb1);
                b = FF(b, c, d, a, x[k + 11], S14, 0x895cd7be);
                a = FF(a, b, c, d, x[k + 12], S11, 0x6b901122);
                d = FF(d, a, b, c, x[k + 13], S12, 0xfd987193);
                c = FF(c, d, a, b, x[k + 14], S13, 0xa679438e);
                b = FF(b, c, d, a, x[k + 15], S14, 0x49b40821);
                a = GG(a, b, c, d, x[k + 1], S21, 0xf61e2562);
                d = GG(d, a, b, c, x[k + 6], S22, 0xc040b340);
                c = GG(c, d, a, b, x[k + 11], S23, 0x265e5a51);
                b = GG(b, c, d, a, x[k + 0], S24, 0xe9b6c7aa);
                a = GG(a, b, c, d, x[k + 5], S21, 0xd62f105d);
                d = GG(d, a, b, c, x[k + 10], S22, 0x2441453);
                c = GG(c, d, a, b, x[k + 15], S23, 0xd8a1e681);
                b = GG(b, c, d, a, x[k + 4], S24, 0xe7d3fbc8);
                a = GG(a, b, c, d, x[k + 9], S21, 0x21e1cde6);
                d = GG(d, a, b, c, x[k + 14], S22, 0xc33707d6);
                c = GG(c, d, a, b, x[k + 3], S23, 0xf4d50d87);
                b = GG(b, c, d, a, x[k + 8], S24, 0x455a14ed);
                a = GG(a, b, c, d, x[k + 13], S21, 0xa9e3e905);
                d = GG(d, a, b, c, x[k + 2], S22, 0xfcefa3f8);
                c = GG(c, d, a, b, x[k + 7], S23, 0x676f02d9);
                b = GG(b, c, d, a, x[k + 12], S24, 0x8d2a4c8a);
                a = HH(a, b, c, d, x[k + 5], S31, 0xfffa3942);
                d = HH(d, a, b, c, x[k + 8], S32, 0x8771f681);
                c = HH(c, d, a, b, x[k + 11], S33, 0x6d9d6122);
                b = HH(b, c, d, a, x[k + 14], S34, 0xfde5380c);
                a = HH(a, b, c, d, x[k + 1], S31, 0xa4beea44);
                d = HH(d, a, b, c, x[k + 4], S32, 0x4bdecfa9);
                c = HH(c, d, a, b, x[k + 7], S33, 0xf6bb4b60);
                b = HH(b, c, d, a, x[k + 10], S34, 0xbebfbc70);
                a = HH(a, b, c, d, x[k + 13], S31, 0x289b7ec6);
                d = HH(d, a, b, c, x[k + 0], S32, 0xeaa127fa);
                c = HH(c, d, a, b, x[k + 3], S33, 0xd4ef3085);
                b = HH(b, c, d, a, x[k + 6], S34, 0x4881d05);
                a = HH(a, b, c, d, x[k + 9], S31, 0xd9d4d039);
                d = HH(d, a, b, c, x[k + 12], S32, 0xe6db99e5);
                c = HH(c, d, a, b, x[k + 15], S33, 0x1fa27cf8);
                b = HH(b, c, d, a, x[k + 2], S34, 0xc4ac5665);
                a = II(a, b, c, d, x[k + 0], S41, 0xf4292244);
                d = II(d, a, b, c, x[k + 7], S42, 0x432aff97);
                c = II(c, d, a, b, x[k + 14], S43, 0xab9423a7);
                b = II(b, c, d, a, x[k + 5], S44, 0xfc93a039);
                a = II(a, b, c, d, x[k + 12], S41, 0x655b59c3);
                d = II(d, a, b, c, x[k + 3], S42, 0x8f0ccc92);
                c = II(c, d, a, b, x[k + 10], S43, 0xffeff47d);
                b = II(b, c, d, a, x[k + 1], S44, 0x85845dd1);
                a = II(a, b, c, d, x[k + 8], S41, 0x6fa87e4f);
                d = II(d, a, b, c, x[k + 15], S42, 0xfe2ce6e0);
                c = II(c, d, a, b, x[k + 6], S43, 0xa3014314);
                b = II(b, c, d, a, x[k + 13], S44, 0x4e0811a1);
                a = II(a, b, c, d, x[k + 4], S41, 0xf7537e82);
                d = II(d, a, b, c, x[k + 11], S42, 0xbd3af235);
                c = II(c, d, a, b, x[k + 2], S43, 0x2ad7d2bb);
                b = II(b, c, d, a, x[k + 9], S44, 0xeb86d391);
                a = addUnsigned(a, AA);
                b = addUnsigned(b, BB);
                c = addUnsigned(c, CC);
                d = addUnsigned(d, DD);
            }
            return (toHex(a) + toHex(b) + toHex(c) + toHex(d)).toLowerCase();
        },

        /** 天翼个人盘：开放接口 getFile.action，用于补全文件 MD5。 */
        async getPersonalFileDetails(fileId) {
            const appKey = "600100422";
            const timestamp = String(Date.now());
            const params = { fileId: String(fileId) };
            const signature = this.sign({
                ...params,
                Timestamp: timestamp,
                AppKey: appKey,
            });
            const url =
                "https://cloud.189.cn/api/open/file/getFile.action?" +
                new URLSearchParams(params).toString();
            const text = String(
                await helper.get(url, {
                    Accept: "application/json;charset=UTF-8",
                    "Sign-Type": "1",
                    Signature: signature,
                    Timestamp: timestamp,
                    AppKey: appKey,
                }),
            );
            const data = /** @type {any} */ (
                JSON.parse(
                    text.replace(
                        /"(id|fileId|parentId|shareId)":"?(\d{15,})"?/g,
                        '"$1":"$2"',
                    ),
                )
            );
            if (data.res_code !== 0) {
                throw new Error(data.res_message || String(data.res_code));
            }
            const md5 =
                data.md5 ||
                data.file?.md5 ||
                data.fileData?.md5 ||
                data.userFile?.md5 ||
                "";
            return { md5: String(md5 || "").toLowerCase() };
        },

        async listPersonal(folderId, path = "") {
            const files = [];
            let pageNum = 1;
            const pageSize = 100;
            while (true) {
                const appKey = "600100422";
                const timestamp = String(Date.now());
                const params = {
                    folderId: String(folderId),
                    pageNum: String(pageNum),
                    pageSize: String(pageSize),
                    orderBy: "lastOpTime",
                    descending: "true",
                };
                const signature = this.sign({
                    ...params,
                    Timestamp: timestamp,
                    AppKey: appKey,
                });
                const url = `https://cloud.189.cn/api/open/file/listFiles.action?${new URLSearchParams(
                    /** @type {Record<string, string>} */ (params),
                ).toString()}`;
                const text = String(
                    await helper.get(url, {
                        Accept: "application/json;charset=UTF-8",
                        "Sign-Type": "1",
                        Signature: signature,
                        Timestamp: timestamp,
                        AppKey: appKey,
                    }),
                );
                const data = /** @type {any} */ (JSON.parse(text));
                if (data.res_code !== 0) break;
                const fileList = data.fileListAO?.fileList || [];
                const folderList = data.fileListAO?.folderList || [];
                if (!fileList.length && !folderList.length) break;

                for (const f of fileList) {
                    files.push({
                        path: path ? `${path}/${f.name}` : f.name,
                        etag: (f.md5 || "").toLowerCase(),
                        size: Number(f.size || 0),
                        fileId: f.id,
                    });
                }
                for (const d of folderList) {
                    const subPath = path ? `${path}/${d.name}` : d.name;
                    files.push(...(await this.listPersonal(d.id, subPath)));
                }
                if (fileList.length + folderList.length < pageSize) break;
                pageNum++;
            }
            return files;
        },

        async getFiles() {
            const selected = this.getSelectedFiles();
            if (!selected.length) throw new Error("请先勾选天翼文件/文件夹");
            const all = [];
            for (const item of selected) {
                const id = item.id || item.fileId;
                const name = item.name || item.fileName;
                const isFolder = item.isFolder || item.fileCata === 2;
                if (isFolder) {
                    all.push(...(await this.listPersonal(id, name)));
                } else {
                    all.push({
                        path: name,
                        etag: (item.md5 || "").toLowerCase(),
                        size: Number(item.size || 0),
                        fileId: id,
                    });
                }
            }
            if (!all.length) throw new Error("未找到可导出的天翼文件");

            const missing = all.filter((f) => f.path && !f.etag && f.fileId);
            for (let i = 0; i < missing.length; i++) {
                const f = missing[i];
                try {
                    helper.updateLoadingMsg(
                        `正在补全文件 MD5 (${i + 1}/${missing.length})...`,
                    );
                    const d = await this.getPersonalFileDetails(f.fileId);
                    f.etag = (d.md5 || "").toLowerCase();
                } catch {
                    /* skip md5 for this file */
                }
                await helper.sleep(100);
            }
            return all;
        },

        /** 提取码、checkAccessCode、分享标题 */
        async getBaseShareInfo(shareUrl, sharePwd = "") {
            const match =
                shareUrl.match(/\/t\/([a-zA-Z0-9]+)/) ||
                shareUrl.match(/[?&]code=([a-zA-Z0-9]+)/);
            if (!match) throw new Error("无效的189网盘分享链接");

            const shareCode = match[1];
            let accessCode = sharePwd || "";

            if (!accessCode) {
                const cookieName = `share_${shareCode}`;
                const cookiePwd = helper.getCookie(cookieName);
                if (cookiePwd) {
                    accessCode = cookiePwd;
                } else {
                    try {
                        const decodedUrl = decodeURIComponent(shareUrl);
                        const pwdMatch = decodedUrl.match(
                            /[（(]访问码[：:]\s*([a-zA-Z0-9]+)/,
                        );
                        if (pwdMatch && pwdMatch[1]) accessCode = pwdMatch[1];
                    } catch {
                        /* ignore */
                    }
                }
            }

            let shareId = shareCode;

            if (accessCode) {
                const checkUrl =
                    "https://cloud.189.cn/api/open/share/checkAccessCode.action?" +
                    `shareCode=${encodeURIComponent(shareCode)}&accessCode=${encodeURIComponent(accessCode)}`;
                try {
                    const checkText = await helper.get(checkUrl, {
                        Accept: "application/json;charset=UTF-8",
                        Referer: "https://cloud.189.cn/web/main/",
                    });
                    const checkData = /** @type {any} */ (JSON.parse(checkText));
                    if (checkData.shareId) shareId = checkData.shareId;
                } catch {
                    /* ignore */
                }
            }

            const params = { shareCode, accessCode };
            const timestamp = String(Date.now());
            const appKey = "600100422";
            const signData = { ...params, Timestamp: timestamp, AppKey: appKey };
            const signature = this.sign(signData);
            const apiUrl = `https://cloud.189.cn/api/open/share/getShareInfoByCodeV2.action?${new URLSearchParams(
                params,
            ).toString()}`;

            const text = String(
                await helper.get(apiUrl, {
                    Accept: "application/json;charset=UTF-8",
                    "Sign-Type": "1",
                    Signature: signature,
                    Timestamp: timestamp,
                    AppKey: appKey,
                    Referer: "https://cloud.189.cn/web/main/",
                }),
            );

            let data;
            try {
                data = /** @type {any} */ (
                    JSON.parse(
                        text.replace(
                            /"(id|fileId|parentId|shareId)":"?(\d{15,})"?/g,
                            '"$1":"$2"',
                        ),
                    )
                );
            } catch {
                throw new Error("解析分享信息失败");
            }

            if (data.res_code !== 0) {
                if (data.res_code === 40401 && !accessCode) {
                    throw new Error("该分享需要提取码，请输入提取码");
                }
                throw new Error(
                    `获取分享信息失败: ${data.res_message || data.res_code || "未知错误"}`,
                );
            }

            return {
                shareId: data.shareId || shareId,
                shareMode: data.shareMode || "0",
                accessCode,
                shareCode,
                title: data.fileName || "",
            };
        },

        async listShare(
            shareId,
            shareDirFileId,
            fileId,
            path = "",
            shareMode = "0",
            accessCode = "",
            shareCode = "",
        ) {
            const files = [];
            let page = 1;
            while (true) {
                const params = {
                    pageNum: String(page),
                    pageSize: "100",
                    fileId: String(fileId),
                    shareDirFileId: String(shareDirFileId),
                    isFolder: "true",
                    shareId: String(shareId),
                    shareMode,
                    iconOption: "5",
                    orderBy: "lastOpTime",
                    descending: "true",
                    accessCode: accessCode || "",
                };
                /** @type {Record<string, string>} */
                const headers = {
                    Accept: "application/json;charset=UTF-8",
                    Referer: "https://cloud.189.cn/web/main/",
                };
                if (shareCode && accessCode) {
                    headers["Cookie"] = `share_${shareCode}=${accessCode}`;
                }
                const url = `https://cloud.189.cn/api/open/share/listShareDir.action?${new URLSearchParams(
                    params,
                ).toString()}`;
                const text = String(await helper.get(url, headers));
                /** @type {any} */
                let data;
                try {
                    const fixedText = text.replace(
                        /"(id|fileId|parentId|shareId)":(\d{15,})/g,
                        '"$1":"$2"',
                    );
                    data = JSON.parse(fixedText);
                } catch {
                    break;
                }
                if (data.res_code !== 0) {
                    break;
                }
                const fileList = data.fileListAO?.fileList || [];
                const folderList = data.fileListAO?.folderList || [];
                for (const f of fileList) {
                    files.push({
                        path: path ? `${path}/${f.name}` : f.name,
                        etag: (f.md5 || "").toLowerCase(),
                        size: Number(f.size || 0),
                    });
                }
                for (const d of folderList) {
                    const subPath = path ? `${path}/${d.name}` : d.name;
                    files.push(
                        ...(await this.listShare(
                            shareId,
                            d.id,
                            d.id,
                            subPath,
                            shareMode,
                            accessCode,
                            shareCode,
                        )),
                    );
                }
                if (fileList.length + folderList.length < 100) break;
                page++;
            }
            return files;
        },

        async getShareFiles() {
            const selected = this.getSelectedFiles();
            if (!selected.length) throw new Error("请先勾选天翼分享文件/文件夹");
            const info = await this.getBaseShareInfo(location.href, "");
            const all = [];
            for (const item of selected) {
                const id = item.id || item.fileId;
                const name = item.name || item.fileName;
                const isFolder = item.isFolder || item.fileCata === 2;
                if (isFolder) {
                    all.push(
                        ...(await this.listShare(
                            info.shareId,
                            id,
                            id,
                            name,
                            info.shareMode,
                            info.accessCode,
                            info.shareCode,
                        )),
                    );
                } else {
                    all.push({
                        path: name,
                        etag: (item.md5 || "").toLowerCase(),
                        size: Number(item.size || 0),
                    });
                }
            }
            if (!all.length) throw new Error("未找到可导出的天翼分享文件");
            return { files: all, title: info.title || "" };
        },
    };

    function guangyaExtractMd5FromEtag(raw) {
        const s = String(raw ?? "").trim();
        if (!s) return { ok: false, reason: "etag/md5 为空" };
        const lower = s.toLowerCase();
        if (/^[0-9a-f]{32}$/.test(lower)) {
            return { ok: true, md5: lower };
        }
        const stripped = lower.replace(/[^0-9a-f]/g, "");
        if (stripped.length === 32) {
            return { ok: true, md5: stripped };
        }
        if (s.length === 32) {
            const invalid = [];
            for (const ch of s) {
                if (!/[0-9a-f]/i.test(ch)) invalid.push(ch);
            }
            const uniq = [...new Set(invalid)].join("");
            return {
                ok: false,
                reason: `32个字符但含非十六进制符号「${uniq}」，MD5 只能由 0-9、a-f 组成（你当前 etag 不是标准 MD5）`,
            };
        }
        return {
            ok: false,
            reason: `去除分隔符等后仅 ${stripped.length} 位十六进制，需要凑满 32 位`,
        };
    }

    const panGuangya = {
        isHost() {
            const h = location.hostname;
            return h === "guangyapan.com" || h.endsWith(".guangyapan.com");
        },

        pickTokenFromPageStorage() {
            const storages = [localStorage, sessionStorage];
            for (const st of storages) {
                try {
                    for (let i = 0; i < st.length; i++) {
                        const k = st.key(i);
                        if (!k) continue;
                        const v = st.getItem(k);
                        if (!v || v.length > 60000) continue;
                        const keyHit = /token|oauth|auth|session|login|xbase|user/i.test(k);
                        const vHit = /access_token|accessToken/i.test(v.slice(0, 120));
                        if (!keyHit && !vHit) continue;
                        try {
                            const j = JSON.parse(v);
                            const t =
                                j.access_token ||
                                j.accessToken ||
                                (j.token &&
                                    (j.token.access_token || j.token.accessToken)) ||
                                (j.data &&
                                    (j.data.access_token || j.data.accessToken));
                            if (typeof t === "string" && t.length > 20) {
                                return t.trim();
                            }
                        } catch {
                            /* 非 JSON */
                        }
                        if (
                            keyHit &&
                            /^[a-zA-Z0-9._-]{30,}$/.test(v.trim()) &&
                            !v.includes("{")
                        ) {
                            return v.trim();
                        }
                    }
                } catch {
                    /* ignore */
                }
            }
            return "";
        },

        async getAccessToken() {
            let t = String(GM_getValue(KEY_GUANGYA_ACCESS_TOKEN, "") || "").trim();
            if (t) return t;
            t = panGuangya.pickTokenFromPageStorage();
            if (t) return t;
            return await panGuangya.promptPasteToken();
        },

        promptPasteToken() {
            return new Promise((resolve) => {
                const backdrop = document.createElement("div");
                Object.assign(backdrop.style, {
                    position: "fixed",
                    inset: "0",
                    background: "rgba(0,0,0,0.45)",
                    zIndex: "2147483646",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: "system-ui,sans-serif",
                });
                const box = document.createElement("div");
                box.style.cssText =
                    "background:#fff;padding:18px 20px;border-radius:10px;max-width:92vw;width:440px;box-shadow:0 8px 32px rgba(0,0,0,.2)";
                const p = document.createElement("p");
                p.style.cssText =
                    "margin:0 0 10px;font-size:13px;line-height:1.55;color:#333;";
                p.innerHTML =
                    "未在页面存储中找到 access_token。<br/>请在<strong>已登录</strong>状态下打开开发者工具 → Network，点选任意发往 <code>api.guangyapan.com</code> 的请求，在请求头里复制 <code>Authorization</code> 的 Bearer 后面整段 token；或从 Application → Local Storage 里找 JSON 中的 <code>access_token</code>。";
                const inp = document.createElement("input");
                inp.type = "password";
                inp.placeholder = "粘贴 access_token（可含 Bearer 前缀）";
                inp.style.cssText =
                    "width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #ccc;border-radius:6px;font-size:13px;margin-bottom:12px;";
                const row = document.createElement("div");
                row.style.cssText =
                    "display:flex;gap:10px;justify-content:flex-end;";
                const btnOk = document.createElement("button");
                btnOk.textContent = "确定并保存";
                btnOk.style.cssText =
                    "padding:8px 16px;border-radius:6px;border:none;background:#1677ff;color:#fff;cursor:pointer;";
                const btnCancel = document.createElement("button");
                btnCancel.textContent = "取消";
                btnCancel.style.cssText =
                    "padding:8px 16px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer;";
                const cleanup = () => backdrop.remove();
                btnCancel.onclick = () => {
                    cleanup();
                    resolve("");
                };
                btnOk.onclick = () => {
                    let v = inp.value.trim();
                    if (v.startsWith("Bearer ")) v = v.slice(7).trim();
                    if (v) GM_setValue(KEY_GUANGYA_ACCESS_TOKEN, v);
                    cleanup();
                    resolve(v);
                };
                row.appendChild(btnCancel);
                row.appendChild(btnOk);
                box.appendChild(p);
                box.appendChild(inp);
                box.appendChild(row);
                backdrop.appendChild(box);
                document.body.appendChild(backdrop);
                inp.focus();
            });
        },

        showImportDialog() {
            const backdrop = document.createElement("div");
            Object.assign(backdrop.style, {
                position: "fixed",
                inset: "0",
                background: "rgba(0,0,0,0.45)",
                zIndex: "2147483646",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: "system-ui,sans-serif",
            });
            const box = document.createElement("div");
            box.style.cssText =
                "background:#fff;padding:18px 20px;border-radius:10px;max-width:94vw;width:520px;max-height:88vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,.2)";
            const title = document.createElement("div");
            title.textContent = "导入秒传 JSON 到当前账号";
            title.style.cssText =
                "font-weight:600;font-size:15px;margin-bottom:10px;color:#111;";
            const hint = document.createElement("p");
            hint.style.cssText =
                "margin:0 0 8px;font-size:12px;line-height:1.5;color:#555;";
            hint.innerHTML =
                "可<strong>粘贴</strong> JSON 或<strong>选择单个 .json 文件</strong>（<code>files</code>：path、<code>etag</code>=32 位十六进制 MD5、size）。<br>选择文件后会<strong>自动校验</strong> JSON 结构；不符则不会填入下方。<br>可点「清除」去掉已选文件并清空下方内容后重新选择。";
            const fileRow = document.createElement("div");
            fileRow.style.cssText =
                "margin:10px 0 8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;";
            const filePickLabel = document.createElement("span");
            filePickLabel.textContent = "选择文件：";
            filePickLabel.style.cssText =
                "font-size:12px;color:#555;flex-shrink:0;";
            const fileInput = document.createElement("input");
            fileInput.type = "file";
            fileInput.accept = ".json,application/json,text/json";
            fileInput.style.cssText =
                "font-size:12px;max-width:min(100%,280px);";
            const btnClearFile = document.createElement("button");
            btnClearFile.type = "button";
            btnClearFile.textContent = "清除";
            btnClearFile.title = "清空已选文件与下方 JSON，可重新选择";
            btnClearFile.style.cssText =
                "padding:4px 12px;border-radius:6px;border:1px solid #ccc;background:#fff;color:#333;cursor:pointer;font-size:12px;flex-shrink:0;";
            const fileLoadedHint = document.createElement("span");
            fileLoadedHint.style.cssText =
                "font-size:11px;color:#888;word-break:break-all;flex:1;min-width:120px;";
            const readFileAsTextPromise = (file) =>
                new Promise((resolve, reject) => {
                    const r = new FileReader();
                    r.onload = () => resolve(String(r.result || ""));
                    r.onerror = () => reject(new Error("读取失败"));
                    try {
                        r.readAsText(file, "UTF-8");
                    } catch (e) {
                        reject(e);
                    }
                });
            fileInput.addEventListener("change", async () => {
                const picked = fileInput.files;
                fileLoadedHint.textContent = "";
                if (!picked || picked.length === 0) return;
                const f = picked[0];
                const onReadFail = () => {
                    fileLoadedHint.textContent = "";
                    status.style.color = "#c00";
                    status.textContent = "读取文件失败，请重试或改用粘贴";
                };
                try {
                    const text = await readFileAsTextPromise(f);
                    const vr = validateGuangyaImportJsonShape(text);
                    if (!vr.ok) {
                        fileInput.value = "";
                        ta.value = "";
                        fileLoadedHint.textContent = "";
                        status.style.color = "#c00";
                        status.textContent = `格式不符：${vr.message}`;
                        return;
                    }
                    ta.value = text;
                    fileLoadedHint.textContent = `格式校验通过 · ${f.name}（${(f.size / 1024).toFixed(1)} KB），共 ${vr.fileCount} 条`;
                    status.textContent = "";
                    status.style.removeProperty("color");
                    setDetailText("");
                } catch {
                    onReadFail();
                }
            });
            fileRow.appendChild(filePickLabel);
            fileRow.appendChild(fileInput);
            fileRow.appendChild(btnClearFile);
            fileRow.appendChild(fileLoadedHint);
            const ta = document.createElement("textarea");
            ta.placeholder = '{"files":[{"path":"a.mp4","etag":"…32位md5…","size":123}]}';
            ta.style.cssText =
                "width:100%;box-sizing:border-box;min-height:180px;padding:10px;border:1px solid #ccc;border-radius:6px;font-size:12px;font-family:ui-monospace,monospace;margin-top:4px;";
            const status = document.createElement("div");
            status.style.cssText =
                "margin-top:10px;font-size:12px;color:#c00;min-height:18px;white-space:pre-wrap;";
            const detailWrap = document.createElement("div");
            detailWrap.style.cssText = "display:none;margin-top:10px;";
            const detailLabel = document.createElement("div");
            detailLabel.textContent =
                "分类明细（接口失败 / 秒传失败 / 校验），可滚动复制";
            detailLabel.style.cssText =
                "font-size:12px;color:#666;margin-bottom:6px;";
            const detailTa = document.createElement("textarea");
            detailTa.readOnly = true;
            detailTa.rows = 14;
            detailTa.style.cssText =
                "width:100%;box-sizing:border-box;font-size:11px;line-height:1.4;font-family:ui-monospace,monospace;padding:8px;border:1px solid #ddd;border-radius:6px;resize:vertical;min-height:160px;";
            const copyRow = document.createElement("div");
            copyRow.style.cssText =
                "margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
            const btnCopyDetail = document.createElement("button");
            btnCopyDetail.type = "button";
            btnCopyDetail.textContent = "复制详情";
            btnCopyDetail.style.cssText =
                "padding:6px 14px;border-radius:6px;border:1px solid #1677ff;background:#e6f4ff;color:#1677ff;cursor:pointer;font-size:12px;";
            const copyHint = document.createElement("span");
            copyHint.style.cssText = "font-size:11px;color:#999;";
            copyHint.textContent = "";
            copyRow.appendChild(btnCopyDetail);
            copyRow.appendChild(copyHint);
            btnCopyDetail.onclick = () => {
                const t = detailTa.value;
                if (!t) return;
                try {
                    if (typeof GM_setClipboard === "function") {
                        GM_setClipboard(t, "text");
                        copyHint.textContent = "已复制";
                        setTimeout(() => {
                            copyHint.textContent = "";
                        }, 2000);
                        return;
                    }
                } catch {
                    /* fallthrough */
                }
                detailTa.focus();
                detailTa.select();
                try {
                    document.execCommand("copy");
                    copyHint.textContent = "已复制";
                    setTimeout(() => {
                        copyHint.textContent = "";
                    }, 2000);
                } catch {
                    copyHint.textContent = "请手动 Ctrl+C";
                }
            };
            detailWrap.appendChild(detailLabel);
            detailWrap.appendChild(detailTa);
            detailWrap.appendChild(copyRow);
            const setDetailText = (text) => {
                if (text) {
                    detailTa.value = text;
                    detailWrap.style.display = "block";
                } else {
                    detailTa.value = "";
                    detailWrap.style.display = "none";
                }
            };
            btnClearFile.onclick = () => {
                fileInput.value = "";
                fileLoadedHint.textContent = "";
                ta.value = "";
                status.textContent = "";
                status.style.removeProperty("color");
                setDetailText("");
            };
            const row = document.createElement("div");
            row.style.cssText =
                "display:flex;gap:10px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap;";
            const btnRun = document.createElement("button");
            btnRun.textContent = "开始导入";
            btnRun.style.cssText =
                "padding:8px 16px;border-radius:6px;border:none;background:#1677ff;color:#fff;cursor:pointer;";
            const btnClose = document.createElement("button");
            btnClose.textContent = "关闭";
            btnClose.style.cssText =
                "padding:8px 16px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer;";
            const cleanup = () => backdrop.remove();
            btnClose.onclick = cleanup;
            btnRun.onclick = async () => {
                status.textContent = "";
                setDetailText("");
                btnRun.textContent = "导入中";
                btnRun.disabled = true;
                btnRun.style.cursor = "not-allowed";
                btnRun.style.opacity = "0.75";
                status.style.color = "#1677ff";
                status.textContent = "导入中...";
                try {
                    const r = await panGuangya.importMd5Json(
                        ta.value,
                        (p) => {
                            status.style.color = "#1677ff";
                            if (p.phase === "mkdir") {
                                status.textContent = `导入中... 创建目录 ${p.index}/${p.total}`;
                            } else if (p.phase === "probe") {
                                status.textContent = `导入中... 秒传 ${p.index}/${p.total}`;
                            } else {
                                status.textContent = `导入中... 第 ${p.index}/${p.total} 批（本批 ${p.chunkSize} 条）`;
                            }
                        },
                    );
                    const sum =
                        r.importSummary ||
                        (() => {
                            const c = guangyaParseImportResultCounts(
                                r.resp,
                                r.okCount,
                                r.skipCount,
                            );
                            const transferFail = Math.max(
                                0,
                                c.failCount - (r.skipCount || 0),
                            );
                            const xfer = guangyaTransferFailRowsFromResp(
                                r.resp,
                                [],
                            );
                            return {
                                batchCount: 1,
                                transferSuccess: c.successCount,
                                transferFail,
                                skipCount: r.skipCount || 0,
                                transferFailedEntries: xfer,
                                transferFailedMissingDetail:
                                    transferFail > 0 && xfer.length === 0,
                            };
                        })();
                    const mkdirFailedCount =
                        sum.mkdirFailedCount != null
                            ? Number(sum.mkdirFailedCount) || 0
                            : Array.isArray(r.skipped)
                              ? r.skipped.filter((x) =>
                                    String(x).includes("创建目录失败"),
                                ).length
                              : 0;
                    const transferTotal =
                        sum.transferSuccess + sum.transferFail + mkdirFailedCount;
                    const transferFailTotal = sum.transferFail + mkdirFailedCount;
                    const nonMkdirSkipCount = Math.max(
                        0,
                        (sum.skipCount || 0) - mkdirFailedCount,
                    );
                    const probeCount =
                        sum.probeTotal != null
                            ? Number(sum.probeTotal) || 0
                            : sum.transferSuccess + sum.transferFail;
                    const ifaceLine = `阶段统计：创建目录失败（未进入秒传）${mkdirFailedCount} 条；进入秒传阶段 ${probeCount} 条。`;
                    const lines = [
                        ifaceLine,
                        `秒传结果：共 ${transferTotal} 条，成功 ${sum.transferSuccess} 条，失败 ${transferFailTotal} 条，其中 ${mkdirFailedCount} 条因创建目录失败未导入。`,
                    ];
                    if (nonMkdirSkipCount > 0) {
                        lines.push(
                            `校验未通过（未提交接口）：${nonMkdirSkipCount} 条。`,
                        );
                    }
                    const warn = transferFailTotal > 0 || nonMkdirSkipCount > 0;
                    status.style.color = warn ? "#a60" : "#080";
                    status.textContent = lines.join("\n");
                    const xferRows = sum.transferFailedEntries || [];
                    const needCopy =
                        sum.transferFail > 0 ||
                        sum.skipCount > 0 ||
                        sum.transferFailedMissingDetail;
                    if (needCopy) {
                        const transferExtra = [];
                        const rawSkipped = Array.isArray(r.skipped) ? r.skipped : [];
                        const mkdirSkipLines = rawSkipped.filter((x) =>
                            String(x).includes("创建目录失败"),
                        );
                        const validateSkipLines = rawSkipped.filter(
                            (x) => !String(x).includes("创建目录失败"),
                        );
                        if (sum.transferFailedMissingDetail && sum.transferFail > 0) {
                            transferExtra.push(
                                `（说明：共有 ${sum.transferFail} 条秒传失败，但接口未返回失败明细，无法逐条列出路径。）`,
                            );
                        }
                        setDetailText(
                            formatGuangyaImportCopyReport({
                                interfaceLines: [
                                    "（无）各批 HTTP 状态与业务 code 均成功。",
                                ],
                                transferRows: xferRows,
                                mkdirSkipLines:
                                    mkdirSkipLines.length > 0
                                        ? mkdirSkipLines
                                        : undefined,
                                validateSkipLines:
                                    validateSkipLines.length > 0
                                        ? validateSkipLines
                                        : undefined,
                                transferExtraLines: transferExtra,
                            }),
                        );
                    } else {
                        setDetailText("");
                    }
                } catch (e) {
                    status.style.color = "#c00";
                    status.textContent = e?.message || String(e);
                    const iface = [
                        e?.message || String(e),
                        "",
                        e?.importFailedAtMkdirIndex != null
                            ? `失败位置：第 ${e.importFailedAtMkdirIndex} 条（创建目录阶段）。`
                            : e?.importFailedAtProbeIndex != null
                              ? `失败位置：第 ${e.importFailedAtProbeIndex} 条（秒传阶段）。`
                              : e?.importFailedAtBatchIndex != null
                                ? `失败位置：第 ${e.importFailedAtBatchIndex} 批。`
                                : "",
                    ].filter(Boolean);
                    if (e?.guangyaDetail) {
                        iface.push("", String(e.guangyaDetail));
                    }
                    const xferRows = Array.isArray(e?.partialTransferFailures)
                        ? e.partialTransferFailures
                        : [];
                    setDetailText(
                        formatGuangyaImportCopyReport({
                            interfaceLines: iface,
                            transferRows: xferRows,
                        }),
                    );
                } finally {
                    btnRun.textContent = "开始导入";
                    btnRun.disabled = false;
                    btnRun.style.cursor = "pointer";
                    btnRun.style.opacity = "1";
                }
            };
            row.appendChild(btnClose);
            row.appendChild(btnRun);
            box.appendChild(title);
            box.appendChild(hint);
            box.appendChild(fileRow);
            box.appendChild(ta);
            box.appendChild(status);
            box.appendChild(detailWrap);
            box.appendChild(row);
            backdrop.appendChild(box);
            document.body.appendChild(backdrop);
            ta.focus();
        },

        async importMd5Json(rawJson, onBatchProgress) {
            let obj;
            try {
                obj = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
            } catch {
                const err = new Error("JSON 解析失败");
                err.guangyaDetail = guangyaJsonDetail({
                    summary: err.message,
                    phase: "解析输入",
                });
                throw err;
            }
            const list = Array.isArray(obj.files) ? obj.files : [];
            if (!list.length) {
                const err = new Error("JSON 中无 files 数组");
                err.guangyaDetail = guangyaJsonDetail({
                    summary: err.message,
                    phase: "校验",
                    hint: "顶层需有 files 数组",
                });
                throw err;
            }

            const token = await panGuangya.getAccessToken();
            if (!token) {
                const err = new Error("未设置 access_token，已取消");
                err.guangyaDetail = guangyaJsonDetail({
                    summary: err.message,
                    phase: "登录态",
                });
                throw err;
            }

            const rootParentId = "";

            const files = [];
            const skip = [];
            for (const f of list) {
                const pathStr = String(f.path || "").trim();
                const nameStr = String(f.name || "").trim();
                const fullPath = pathStr || nameStr || "file";
                const numSize = Number(f.size != null ? f.size : 0);
                const ex = guangyaExtractMd5FromEtag(f.etag || f.md5);
                if (!ex.ok) {
                    skip.push(`${fullPath}：${ex.reason}`);
                    continue;
                }
                files.push({
                    md5: ex.md5,
                    filePath: fullPath,
                    fileName: guangyaBasenameFromPath(fullPath),
                    dirSegments: guangyaDirSegmentsFromPath(fullPath),
                    fileSize: Number.isFinite(numSize) && numSize >= 0 ? numSize : 0,
                });
            }

            if (!files.length) {
                const preview = skip.slice(0, 5).join("\n");
                const msg = `没有可用的有效 MD5，常见原因：etag 虽 32 位但含字母 p/n 等非十六进制字符（不是标准 MD5）。\n${preview}${skip.length > 5 ? "\n…" : ""}`;
                const err = new Error(msg);
                err.guangyaDetail = guangyaJsonDetail({
                    summary: "无有效 MD5 条目",
                    phase: "校验",
                    skipped: skip,
                    parentId: rootParentId,
                });
                throw err;
            }

            const dirIdCache = new Map();
            dirIdCache.set("", rootParentId);
            let mkdirFailedCount = 0;
            const ensureDirPath = async (row) => {
                const parts = Array.isArray(row.dirSegments) ? row.dirSegments : [];
                if (!parts.length) return rootParentId;
                let currentParentId = rootParentId;
                let fullDirPath = "";
                for (const dirNameRaw of parts) {
                    const dirName = String(dirNameRaw || "").trim();
                    if (!dirName) continue;
                    fullDirPath = fullDirPath ? `${fullDirPath}/${dirName}` : dirName;
                    if (dirIdCache.has(fullDirPath)) {
                        currentParentId = String(dirIdCache.get(fullDirPath) || "");
                        continue;
                    }
                    const parentIdForReq = String(currentParentId || "");
                    let mkdirBody;
                    try {
                        const ret = await helper.postJsonGuangya(
                            GUANGYA_URL_CREATE_DIR,
                            {
                                dirName,
                                parentId: parentIdForReq,
                                failIfNameExist: true,
                            },
                            token,
                            {
                                allowedBusinessCodes: [0, GUANGYA_CODE_DIR_EXISTS],
                            },
                        );
                        mkdirBody = ret.data;
                    } catch (mkdirErr) {
                        mkdirFailedCount += 1;
                        let codeText = "";
                        try {
                            const d = JSON.parse(String(mkdirErr?.guangyaDetail || "{}"));
                            if (d && d.responseBody && d.responseBody.code != null) {
                                codeText = String(d.responseBody.code);
                            }
                        } catch {
                            /* ignore */
                        }
                        skip.push(
                            `${row.filePath}：创建目录失败（目录=${fullDirPath}${codeText ? `，code=${codeText}` : ""}），已跳过`,
                        );
                        return null;
                    }
                    const code = mkdirBody && mkdirBody.code;
                    const nextId = guangyaPickFileIdFromObj(mkdirBody && mkdirBody.data);
                    if (!nextId) {
                        mkdirFailedCount += 1;
                        skip.push(
                            `${row.filePath}：创建目录失败（目录=${fullDirPath}，code=${code}，无法取得目录ID），已跳过`,
                        );
                        return null;
                    }
                    dirIdCache.set(fullDirPath, nextId);
                    currentParentId = nextId;
                }
                return String(currentParentId || "");
            };

            const payloadFiles = [];
            for (let i = 0; i < files.length; i++) {
                const row = files[i];
                if (typeof onBatchProgress === "function") {
                    try {
                        onBatchProgress({
                            phase: "mkdir",
                            index: i + 1,
                            total: files.length,
                            chunkSize: 1,
                        });
                    } catch {
                        /* ignore */
                    }
                }
                const parentId = await ensureDirPath(row);
                if (parentId == null) {
                    continue;
                }
                payloadFiles.push({
                    md5: row.md5,
                    filePath: row.filePath,
                    fileName: row.fileName,
                    fileSize: row.fileSize,
                    parentId,
                });
            }

            let lastResp = null;
            let aggTransferOk = 0;
            let aggTransferFail = 0;
            /** @type {{ md5: string; filePath: string }[]} */
            const transferFailedEntries = [];

            const probeTotal = payloadFiles.length;
            let instantHitCount = 0;

            const pushFailRow = (row) => {
                aggTransferFail += 1;
                transferFailedEntries.push({
                    md5: row.md5,
                    filePath: row.filePath,
                });
            };

            for (let fi = 0; fi < payloadFiles.length; fi++) {
                const row = payloadFiles[fi];
                if (typeof onBatchProgress === "function") {
                    try {
                        onBatchProgress({
                            phase: "probe",
                            index: fi + 1,
                            total: probeTotal,
                            chunkSize: 1,
                        });
                    } catch {
                        /* ignore */
                    }
                }
                await helper.sleep(0);
                try {
                    const { data: apiBody } = await helper.postJsonGuangya(
                        GUANGYA_URL_GET_RES_CENTER_TOKEN,
                        {
                            capacity: 1,
                            res: {
                                md5: row.md5,
                                fileSize: row.fileSize,
                            },
                            name: row.fileName || guangyaBasenameFromPath(row.filePath),
                            parentId: String(row.parentId || ""),
                        },
                        token,
                        {
                            allowedBusinessCodes: [
                                0,
                                GUANGYA_CODE_RES_TOKEN_INSTANT,
                            ],
                        },
                    );
                    lastResp = apiBody;
                    const code = apiBody && apiBody.code;
                    if (code === GUANGYA_CODE_RES_TOKEN_INSTANT) {
                        instantHitCount += 1;
                        aggTransferOk += 1;
                    } else {
                        const d = apiBody && apiBody.data;
                        const tid =
                            d &&
                            (d.taskId != null
                                ? d.taskId
                                : d.task_id != null
                                  ? d.task_id
                                  : "");
                        if (tid !== "" && tid != null) {
                            try {
                                await helper.postJsonGuangya(
                                    GUANGYA_URL_DELETE_UPLOAD_TASK,
                                    { taskIds: [String(tid)] },
                                    token,
                                );
                            } catch {
                                /* ignore */
                            }
                        }
                        pushFailRow(row);
                    }
                } catch (apiErr) {
                    pushFailRow(row);
                    apiErr.partialTransferFailures = transferFailedEntries.slice();
                    apiErr.importFailedAtProbeIndex = fi + 1;
                    throw apiErr;
                }
            }

            const transferFailedMissingDetail =
                aggTransferFail > 0 && transferFailedEntries.length === 0;
            return {
                resp: lastResp,
                skipCount: skip.length,
                okCount: payloadFiles.length,
                skipped: skip,
                importSummary: {
                    batchCount: 0,
                    probeTotal,
                    instantHitCount,
                    mkdirFailedCount,
                    transferSuccess: aggTransferOk,
                    transferFail: aggTransferFail,
                    skipCount: skip.length,
                    transferFailedEntries,
                    transferFailedMissingDetail,
                },
            };
        },
    };

    async function generate() {
        const host = location.hostname;
        let files;
        let shareTitle = "";

        helper.showLoadingDialog("正在生成秒传 JSON", "请稍候...");
        try {
            if (pan123.is123Host()) {
                files = await pan123.collectFiles();
            } else if (host.includes("quark.cn")) {
                const isSharePage = /^\/(s|share)\//.test(location.pathname);
                if (isSharePage) {
                    const result = await quark.getShareFiles();
                    files = result.files;
                    shareTitle = result.title || "";
                } else {
                    helper.updateLoadingMsg("正在扫描个人文件...");
                    files = await quark.getHomeFiles();
                }
            } else if (host.includes("cloud.189.cn")) {
                const isMain = location.pathname.startsWith("/web/main");
                if (isMain) {
                    files = await tianyi.getFiles();
                } else {
                    const sh = await tianyi.getShareFiles();
                    files = sh.files;
                    shareTitle = sh.title || "";
                }
            } else {
                throw new Error("当前站点不支持");
            }
        } catch (e) {
            helper.closeLoadingDialog();
            throw e;
        }

        const jsonData = helper.makeJson(files);
        helper.closeLoadingDialog();

        if (!jsonData.files.length) {
            const policy = INVALID_ETAG_POLICY;
            if (files.length > 0) {
                throw new Error(
                    `生成结果为空：共 ${files.length} 条记录，但 etag 均为空，已按策略处理（guangya_etag_policy=${policy}）。若为 skip，可尝试：localStorage.setItem("guangya_etag_policy","empty") 后重试。`,
                );
            }
            throw new Error(
                "生成结果为空：没有可导出条目。请勾选文件/文件夹后再生成；若已勾选仍为空，请刷新页面后重试。",
            );
        }
        helper.showResultDialog(jsonData, shareTitle);
    }

    function resolveQuarkContainer() {
        const isShare = /^\/(s|share)\//.test(location.pathname);
        const selectors = isShare
            ? [
                  ".share-btns",
                  ".ant-layout-content .operate-bar",
                  ".share-detail-header .operate-bar",
                  ".share-header-btns",
                  ".share-operate-btns",
                  ".ant-btn-group",
                  ".ant-layout-content",
              ]
            : [
                  ".btn-operate .btn-main",
                  ".btn-operate",
                  ".operate-bar",
                  ".ant-layout-content",
              ];
        for (const s of selectors) {
            const el = document.querySelector(s);
            if (el) return el;
        }
        return null;
    }

    /** 天翼左侧导航/侧栏内会出现与主内容区相似的节点，误匹配会导致按钮飞到左上角 */
    function isInTianyiSidebar(el) {
        if (!el || !el.closest) return false;
        return !!el.closest(
            ".ant-layout-sider, aside, [class*='layout-sider'], [class*='side-bar'], [class*='sidebar'], " +
                "[class*='Sider'], .c-nav-left, .left-nav, [class*='NavLeft'], [class*='nav-left'], " +
                "[class*='menu-side'], [class*='sideMenu']",
        );
    }

    function findTianyiUploadAnchor() {
        const nodes = document.querySelectorAll(
            "button, a, .ant-btn, span.ant-btn, [role='button']",
        );
        for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            if (isInTianyiSidebar(el)) continue;
            const text = (el.textContent || "").replace(/\s+/g, "");
            const aria =
                (el.getAttribute("aria-label") || "") + (el.getAttribute("title") || "");
            if (!text.includes("上传") && !aria.includes("上传")) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            const cs = window.getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden") continue;
            return el;
        }
        return null;
    }

    /**
     * 在多个 FileHead / file-head 节点中选「主文件区工具栏」（含上传/刷新等），排除侧栏误匹配。
     */
    function resolveTianyiFileHeadToolbarScored() {
        const all = document.querySelectorAll(
            '[class*="FileHead"], .file-head-left, .file-head-right, .c-file-head__left, .c-file-head__right',
        );
        let best = null;
        let bestScore = -1;
        for (let i = 0; i < all.length; i++) {
            const el = all[i];
            if (isInTianyiSidebar(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 60 || r.height < 12) continue;
            const cs = window.getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden") continue;
            let score = 0;
            if (el.closest(".ant-layout-content, main, [class*='Content'], [class*='content-main']")) {
                score += 18;
            }
            const snippet = (el.textContent || "").replace(/\s+/g, "").slice(0, 120);
            if (snippet.includes("上传")) score += 25;
            if (snippet.includes("刷新")) score += 10;
            if (snippet.includes("新建文件夹") || snippet.includes("新建")) score += 8;
            // 主区工具栏一般在顶栏下方、偏左，避免选到页脚或侧栏条
            if (r.top > 40 && r.top < 280 && r.left > 80) score += 12;
            if (score > bestScore) {
                bestScore = score;
                best = el;
            }
        }
        return best;
    }

    function resolveTianyiContainer() {
        const isMain = location.pathname.startsWith("/web/main");
        if (!isMain) {
            const shareSelectors = [
                ".file-operate",
                ".outlink-box-b .file-operate",
                ".c-file-operate",
            ];
            for (const s of shareSelectors) {
                const el = document.querySelector(s);
                if (el && !isInTianyiSidebar(el)) return el;
            }
            return null;
        }
        const upload = findTianyiUploadAnchor();
        if (upload && upload.parentElement && !isInTianyiSidebar(upload.parentElement)) {
            return upload.parentElement;
        }
        const scored = resolveTianyiFileHeadToolbarScored();
        if (scored) return scored;
        const legacy = [
            '[class*="FileHead_file-head-left"]',
            ".FileHead_file-head-left",
            ".file-head-left",
            ".c-file-head__left",
        ];
        for (const s of legacy) {
            const els = document.querySelectorAll(s);
            for (let j = 0; j < els.length; j++) {
                const el = els[j];
                if (!isInTianyiSidebar(el)) return el;
            }
        }
        return null;
    }

    /** 生成按钮是否已挂在天翼主文件工具栏附近（非侧栏、非左上角 fixed 兜底） */
    function isGuangyaBtnOkOnTianyi(btn) {
        if (!btn || !btn.isConnected) return false;
        if (isInTianyiSidebar(btn)) return false;
        const r = btn.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        if (r.top > window.innerHeight * 0.55) return false;
        const cs = window.getComputedStyle(btn);
        if (cs.position === "fixed" && r.top < 120 && r.left < 120) return false;
        return true;
    }

    /** 工具栏 flex 横向排布 */
    function ensureTianyiShareToolbarFlexStyle() {
        if (document.getElementById(GUANGYA_TIANYI_SHARE_STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = GUANGYA_TIANYI_SHARE_STYLE_ID;
        style.textContent =
            ".outlink-box-b .file-operate{display:flex!important;flex-wrap:nowrap!important;" +
            "justify-content:flex-end!important;align-items:center!important;float:none!important;" +
            "text-align:unset!important;}" +
            ".outlink-box-b .file-operate .btn-save-as{margin-left:0!important;}";
        document.head.appendChild(style);
    }

    /**
     * 天翼：插到「上传」左侧，或紧挨 123 脚本的「生成JSON」；避免 querySelector 命中侧栏导致 fixed 兜底。
     */
    function tryMountTianyiBesideToolbar() {
        if (!location.hostname.includes("cloud.189.cn")) return false;
        const isMain = location.pathname.startsWith("/web/main");
        const existing = document.getElementById(BTN_ID);
        if (existing && isGuangyaBtnOkOnTianyi(existing)) return true;

        if (existing) existing.remove();

        const jsonGen = document.getElementById("quark-json-generator-btn");
        const upload = findTianyiUploadAnchor();

        if (isMain) {
            if (upload && upload.parentElement) {
                upload.insertAdjacentElement("beforebegin", makeGuangyaButtonElement(false));
                return isGuangyaBtnOkOnTianyi(document.getElementById(BTN_ID));
            }
            if (jsonGen && jsonGen.parentElement && !isInTianyiSidebar(jsonGen)) {
                jsonGen.insertAdjacentElement("afterend", makeGuangyaButtonElement(false));
                return isGuangyaBtnOkOnTianyi(document.getElementById(BTN_ID));
            }
            const row = resolveTianyiFileHeadToolbarScored() || resolveTianyiContainer();
            if (row) {
                row.appendChild(makeGuangyaButtonElement(false));
                return isGuangyaBtnOkOnTianyi(document.getElementById(BTN_ID));
            }
            return false;
        }

        ensureTianyiShareToolbarFlexStyle();

        const fo =
            document.querySelector(".file-operate, .outlink-box-b .file-operate, .c-file-operate") ||
            null;
        if (!fo || isInTianyiSidebar(fo)) return false;
        if (jsonGen && fo.contains(jsonGen)) {
            jsonGen.insertAdjacentElement("afterend", makeGuangyaButtonElement(false));
        } else if (upload && fo.contains(upload)) {
            upload.insertAdjacentElement("beforebegin", makeGuangyaButtonElement(false));
        } else {
            fo.insertBefore(makeGuangyaButtonElement(false), fo.firstChild);
        }
        return isGuangyaBtnOkOnTianyi(document.getElementById(BTN_ID));
    }

    /** `upload-button` / `mfy-button`，优先用它定位，比纯文案稳 */
    function find123UploadInContainer(container) {
        if (!container) return null;
        const byClass = container.querySelector(
            "button.upload-button, .upload-button.ant-btn, button.mfy-button.upload-button, .mfy-button.upload-button",
        );
        if (byClass) return byClass;
        const nodes = container.querySelectorAll("button, .ant-btn, [role='button']");
        for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            const text = (el.textContent || "").replace(/\s+/g, "");
            const aria =
                (el.getAttribute("aria-label") || "") +
                (el.getAttribute("title") || "");
            if (text.includes("上传") || aria.includes("上传")) return el;
        }
        return null;
    }

    /**
     * 在多个 .home-operator-button-group / .home-operator 中选「主文件区」工具栏（避免顶栏横幅先渲染导致误插）。
     */
    function resolve123ToolbarAndUpload() {
        /** @type {{ toolbar: Element; upload: Element; score: number }[]} */
        const candidates = [];
        const groups = document.querySelectorAll(
            ".home-operator-button-group, .home-operator",
        );
        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            const upload = find123UploadInContainer(g);
            if (!upload) continue;
            const rect = g.getBoundingClientRect();
            if (rect.width < 8 || rect.height < 8) continue;
            const cs = window.getComputedStyle(g);
            if (cs.display === "none" || cs.visibility === "hidden") continue;

            let score = 0;
            if (g.closest(".ant-layout-content, main, [class*='layout-content']")) {
                score += 20;
            }
            if (g.querySelector(".upload-button, button.upload-button")) {
                score += 10;
            }
            const cls = (g.className && String(g.className)) || "";
            if (/banner|promo|advert|top-notice|activity/i.test(cls)) {
                score -= 30;
            }
            candidates.push({ toolbar: g, upload, score });
        }
        candidates.sort((a, b) => b.score - a.score);
        if (!candidates.length) return { toolbar: null, upload: null };
        return {
            toolbar: candidates[0].toolbar,
            upload: candidates[0].upload,
        };
    }

    /**
     * 将生成按钮挂到上传左侧；若已有按钮但在错误位置（例如先挂了浮动），则移除后重挂。
     * @returns {boolean} 是否已成功挂载或已正确挂载
     */
    function tryMount123BesideUpload() {
        const { upload } = resolve123ToolbarAndUpload();
        if (!upload || !upload.parentElement) return false;

        const existing = document.getElementById(BTN_ID);
        if (existing) {
            const ok =
                existing.nextElementSibling === upload ||
                upload.previousElementSibling === existing;
            if (ok) return true;
            existing.remove();
        }
        upload.insertAdjacentElement("beforebegin", makeGuangyaButtonElement(false));
        return true;
    }

    function injectGuangyaButtonTypographyStyles() {
        if (document.getElementById(GUANGYA_BTN_TYPO_STYLE_ID)) return;
        const st = document.createElement("style");
        st.id = GUANGYA_BTN_TYPO_STYLE_ID;
        st.textContent =
            "#" +
            BTN_ID +
            ".guangya-rapid-json-btn.ant-btn," +
            "#" +
            BTN_ID +
            ".guangya-rapid-json-btn.ant-btn > span," +
            "#" +
            BTN_GUANGYA_IMPORT_ID +
            ".guangya-rapid-json-btn.ant-btn," +
            "#" +
            BTN_GUANGYA_IMPORT_ID +
            ".guangya-rapid-json-btn.ant-btn > span {" +
            "font-size:18px !important;" +
            "line-height:1.45 !important;" +
            "font-weight:500 !important;" +
            "}";
        document.head.appendChild(st);
    }

    function guangyaAntBtnFromDropdownTrigger(trig) {
        if (!trig || !trig.matches) return null;
        if (trig.matches("button.ant-btn") || trig.matches(".ant-btn")) {
            return trig;
        }
        return trig.querySelector("button.ant-btn, .ant-btn");
    }

    function guangyaIsUploadButtonLabel(normalizedText) {
        if (normalizedText === "上传") return true;
        return /^upload$/i.test(normalizedText);
    }

    function guangyaRowLooksLikeUploadToolbar(row, uploadBtn) {
        if (!row || !uploadBtn) return false;
        const n = (row.textContent || "").replace(/\s+/g, "");
        if (n.includes("新建文件夹") || n.includes("云添加")) return true;
        const primaries = Array.from(
            row.querySelectorAll("button.ant-btn-primary"),
        ).filter((b) => b.id !== BTN_GUANGYA_IMPORT_ID);
        return primaries.length === 1 && primaries[0] === uploadBtn;
    }

    function resolveGuangyaUploadToolbarRow() {
        const triggers = document.querySelectorAll(".ant-dropdown-trigger");
        for (const trig of triggers) {
            const inner = guangyaAntBtnFromDropdownTrigger(trig);
            if (!inner || inner.id === BTN_GUANGYA_IMPORT_ID) continue;
            if (!inner.classList.contains("ant-btn-primary")) continue;
            const txt = (inner.textContent || "").replace(/\s+/g, "");
            if (!guangyaIsUploadButtonLabel(txt)) continue;
            const row = trig.parentElement;
            if (!row || !guangyaRowLooksLikeUploadToolbar(row, inner)) continue;
            return { row, uploadAnchor: trig };
        }

        const primaries = document.querySelectorAll("button.ant-btn-primary");
        for (const inner of primaries) {
            if (inner.id === BTN_GUANGYA_IMPORT_ID) continue;
            const txt = (inner.textContent || "").replace(/\s+/g, "");
            if (!guangyaIsUploadButtonLabel(txt)) continue;
            const row = inner.parentElement;
            if (!row || !guangyaRowLooksLikeUploadToolbar(row, inner)) continue;
            return { row, uploadAnchor: inner };
        }
        return null;
    }

    function makeGuangyaPanImportButtonElement(floating) {
        injectGuangyaButtonTypographyStyles();
        const btn = document.createElement("button");
        btn.id = BTN_GUANGYA_IMPORT_ID;
        btn.type = "button";
        btn.className = "ant-btn ant-btn-primary guangya-rapid-json-btn";
        const span = document.createElement("span");
        span.textContent = "导入秒传JSON";
        btn.appendChild(span);
        span.style.setProperty("font-size", "18px", "important");
        span.style.setProperty("line-height", "1.45", "important");
        span.style.setProperty("font-weight", "500", "important");
        let css =
            "box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;" +
            "height:44px;min-height:44px;padding:0 22px;" +
            "border-radius:8px;white-space:nowrap;cursor:pointer;vertical-align:middle;" +
            "background:#ff9800 !important;border:1px solid #ff9800 !important;color:#fff !important;" +
            "font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,\"Helvetica Neue\",Arial," +
            "\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif;";
        if (floating) {
            css +=
                "position:fixed;left:24px;top:24px;z-index:2147483647;margin-right:0;box-shadow:0 6px 20px rgba(0,0,0,.2);";
        } else {
            css += "position:static;margin-right:0;margin-left:0;";
        }
        btn.style.cssText = css;
        btn.style.setProperty("font-size", "18px", "important");
        btn.style.setProperty("line-height", "1.45", "important");
        btn.onclick = () => {
            try {
                panGuangya.showImportDialog();
            } catch (e) {
                alert(e?.message || String(e));
            }
        };
        return btn;
    }

    function styleGuangyaImportButtonForToolbar(btn) {
        btn.style.position = "static";
        btn.style.left = "";
        btn.style.top = "";
        btn.style.boxShadow = "";
        btn.style.zIndex = "";
        btn.style.marginRight = "0";
        btn.style.verticalAlign = "middle";
    }

    function tryMountGuangyaBesideUpload() {
        const hit = resolveGuangyaUploadToolbarRow();
        if (!hit) return false;
        let btn = document.getElementById(BTN_GUANGYA_IMPORT_ID);
        if (!btn) {
            btn = makeGuangyaPanImportButtonElement(false);
        } else {
            styleGuangyaImportButtonForToolbar(btn);
        }
        const anchor = hit.uploadAnchor;
        if (anchor.previousElementSibling === btn) {
            return true;
        }
        anchor.insertAdjacentElement("beforebegin", btn);
        return true;
    }

    function makeGuangyaButtonElement(floating) {
        injectGuangyaButtonTypographyStyles();
        const btn = document.createElement("button");
        btn.id = BTN_ID;
        btn.type = "button";
        btn.className = "ant-btn ant-btn-primary guangya-rapid-json-btn";
        const span = document.createElement("span");
        span.textContent = "生成秒传JSON";
        btn.appendChild(span);
        span.style.setProperty("font-size", "18px", "important");
        span.style.setProperty("line-height", "1.45", "important");
        span.style.setProperty("font-weight", "500", "important");
        const setLabel = (t) => {
            if (span) span.textContent = t;
            else btn.textContent = t;
        };
        let css =
            "box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;" +
            "height:44px;min-height:44px;padding:0 22px;margin-right:8px;" +
            "border-radius:8px;white-space:nowrap;" +
            "cursor:pointer;vertical-align:middle;" +
            "background:#ff9800 !important;border-color:#ff9800 !important;color:#fff !important;" +
            "font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,\"Helvetica Neue\",Arial," +
            "\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif;";
        if (floating) {
            css +=
                "position:fixed;left:24px;top:24px;z-index:2147483647;margin-right:0;box-shadow:0 6px 20px rgba(0,0,0,.2);";
        }
        btn.style.cssText = css;
        btn.style.setProperty("font-size", "18px", "important");
        btn.style.setProperty("line-height", "1.45", "important");
        btn.onclick = async () => {
            try {
                btn.disabled = true;
                setLabel("生成中...");
                await generate();
                setLabel("生成秒传JSON");
            } catch (e) {
                alert(e?.message || "生成失败");
                setLabel("生成秒传JSON");
            } finally {
                btn.disabled = false;
            }
        };
        return btn;
    }

    function createButton() {
        const host = location.hostname;

        if (panGuangya.isHost()) {
            if (tryMountGuangyaBesideUpload()) return;
            if (!document.getElementById(BTN_GUANGYA_IMPORT_ID)) {
                const body =
                    document.querySelector(BODY_SELECTOR) ||
                    document.documentElement;
                body.appendChild(makeGuangyaPanImportButtonElement(true));
            }
            return;
        }

        if (pan123.is123Host() && PREFER_123_TOOLBAR) {
            if (tryMount123BesideUpload()) return;
            return;
        }

        if (host.includes("cloud.189.cn")) {
            if (tryMountTianyiBesideToolbar()) return;
        }

        if (document.getElementById(BTN_ID)) return;

        if (pan123.is123Host() && !PREFER_123_TOOLBAR) {
            const body = document.querySelector(BODY_SELECTOR) || document.documentElement;
            body.appendChild(makeGuangyaButtonElement(true));
            return;
        }

        /** @type {Element} */
        let container = document.querySelector("*");
        let matchedHost = false;
        let useFloating = false;
        if (pan123.is123Host()) {
            matchedHost = true;
            container =
                document.querySelector(BODY_SELECTOR) || document.documentElement;
            useFloating = true;
        } else if (host.includes("quark.cn")) {
            matchedHost = true;
            const found = resolveQuarkContainer();
            if (!found) {
                container = document.querySelector(BODY_SELECTOR);
                useFloating = true;
            } else {
                container = found;
            }
        } else if (host.includes("cloud.189.cn")) {
            matchedHost = true;
            const found = resolveTianyiContainer();
            if (!found) return;
            container = found;
        }
        if (!matchedHost || !container) return;

        const btn = makeGuangyaButtonElement(useFloating);
        if (
            host.includes("quark.cn") &&
            !/^\/(s|share)\//.test(location.pathname)
        ) {
            if (useFloating) {
                container.appendChild(btn);
            } else {
                container.insertBefore(btn, container.firstChild);
            }
        } else {
            container.appendChild(btn);
        }
    }

    function init() {
        if (
            !location.hostname.includes("quark.cn") &&
            !location.hostname.includes("cloud.189.cn") &&
            !pan123.is123Host() &&
            !panGuangya.isHost()
        ) {
            return;
        }
        const obsRoot = document.body || document.documentElement;
        if (!obsRoot) return;
        injectGuangyaButtonTypographyStyles();
        if (
            location.hostname.includes("cloud.189.cn") &&
            !location.pathname.startsWith("/web/main")
        ) {
            ensureTianyiShareToolbarFlexStyle();
        }
        const observer = new MutationObserver(() => createButton());
        observer.observe(obsRoot, { childList: true, subtree: true });
        createButton();
        [400, 1500, 4000, 8000].forEach((ms) => setTimeout(createButton, ms));
        if (pan123.is123Host()) {
            try {
                pan123.initSelector();
            } catch {
                /* ignore */
            }
        }
    }

    if (typeof GM_registerMenuCommand === "function") {
        try {
            GM_registerMenuCommand("[秒传工具] 清除当前网盘 access_token（GM 保存）", () => {
                GM_setValue(KEY_GUANGYA_ACCESS_TOKEN, "");
                alert("已清除当前网盘 access_token；下次导入会尝试读页面存储或再弹窗粘贴。");
            });
        } catch {
            /* ignore */
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
