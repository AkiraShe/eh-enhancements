// ==UserScript==
// @name         EhAria2下载助手
// @namespace    com.xioxin.AriaEh
// @version      1.3
// @description  发送任务到Aria2,并查看下载进度
// @author       xioxin, SchneeHertz, AkiraShe
// @homepage     https://github.com/AkiraShe/eh-enhancements
// @supportURL   https://github.com/AkiraShe/eh-enhancements/issues
// @include      *://exhentai.org/*
// @include      *://e-hentai.org/*
// @include      *hath.network/archive/*
// @require      https://openuserjs.org/src/libs/sizzle/GM_config.js
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// ==/UserScript==


const IS_EX = window.location.host.includes("exhentai");
const gmc = new GM_config({
    'id': 'AriaEhSetting',
    'title': 'AriaEh设置',
    'fields': {
        'ARIA2_RPC': {
            'section': [ 'ARIA2配置', '如果你的下载服务器不是本机,需要的将域名添加到: <br>设置 - XHR 安全 - 用户域名白名单'],
            'label': 'ARIA2_RPC地址<b style="color: red">(必填)</b>',
            'title': 'ARIA2_RPC地址, 例如: http://127.0.0.1:6800/jsonrpc',
            'labelPos': 'left',
            'type': 'text',
            'default': ''
        },
        'ARIA2_SECRET': {
            'label': 'ARIA2_RPC密钥',
            'title': 'ARIA2_RPC密钥',
            'type': 'text',
            'default': ''
        },
        'ARIA2_DIR': {
            'label': '保存文件位置',
            'title': '例如 /Downloads 或者 D:\\Downloads, 留空将下载到默认位置',
            'type': 'text',
            'default': ''
        },
        'USE_ONE_CLICK_DOWNLOAD': {
            'section': [ '一键下载存档', '该功能是将"存档下载"的连接发送给Aria2.在列表页面与详情页增加橙色下载按钮.<b style="color: #f60">注意该功能会产生下载费用!</b>'],
            'labelPos': 'left',
            'label': '启用',
            'title': '在列表页与详情页增加存档一键下载按钮',
            'type': 'checkbox',
            'default': true
        },
        'ONE_CLICK_DOWNLOAD_DLTYPE': {
            'label': '一键下载画质',
            'type': 'select',
            'labelPos': 'left',
            'options': ['org(原始档案)', 'res(重采样档案)'],
            'default': 'org(原始档案)'
        },
        'USE_TORRENT_POP_LIST': {
            'section': [ '种子下载快捷弹窗', '鼠标指向详情页的"种子下载",或者列表的绿色箭头.将显示种子列表浮窗.并高亮最大体积,最新更新.' ],
            'labelPos': 'left',
            'label': '启用',
            'title': '使用种子下载快捷弹窗',
            'type': 'checkbox',
            'default': true
        },
        'REPLACE_EX_TORRENT_URL': {
            'label': '里站使用表站种子连接',
            'title': '替换里站种子域名为ehtracker.org',
            'type': 'checkbox',
            'default': true
        },
        'USE_MAGNET': {
            'label': '使用磁力链替代种子链接',
            'title': '先将种子转换为磁力链，再发送给Aria2',
            'type': 'checkbox',
            'default': false
        },
        'USE_LIST_TASK_STATUS': {
            'section': [ '下载进度展示'],
            'labelPos': 'left',
            'label': '在搜索列表页',
            'title': '在搜索列表页',
            'type': 'checkbox',
            'default': true
        },
        'USE_GALLERY_DETAIL_TASK_STATUS': {
            'label': '在画廊详情页',
            'title': '在画廊详情页',
            'type': 'checkbox',
            'default': true
        },
        'USE_HATH_ARCHIVE_TASK_STATUS': {
            'label': '在存档下载页面',
            'title': '在存档下载页面',
            'type': 'checkbox',
            'default': true
        },
        'USE_TORRENT_TASK_STATUS': {
            'label': '在种子下载页面',
            'title': '在种子下载页面',
            'type': 'checkbox',
            'default': true
        },
        'INITIALIZED': {
            'type': 'hidden',
            'default': false,
        }
    },
    'events': {
        'init': onConfigInit
    },
    css: `
    #AriaEhSetting { background: #E3E0D1; }
    #AriaEhSetting .config_header { margin-bottom: 8px; }
    #AriaEhSetting .section_header { font-size: 12pt; }
    #AriaEhSetting .section_header_holder { margin-top: 16pt; }
    #AriaEhSetting input, #AriaEhSetting select { background:#E3E0D1; border: 2px solid #B5A4A4; border-radius: 3px; }
    #AriaEhSetting .field_label { display: inline-block; min-width: 150px; text-align: right;}
    ${IS_EX ? `
    #AriaEhSetting { background:#4f535b; color: #FFF; }
    #AriaEhSetting .section_header { border: 1px solid #000;  }
    #AriaEhSetting .section_desc { background:#34353b; border: 1px solid #000; color: #CCC; }
    #AriaEhSetting input, #AriaEhSetting select { background:#34353b; color: #FFF; border: 2px solid #8d8d8d; border-radius: 3px; }
    #AriaEhSetting_resetLink { color: #FFF; }
    `: ''}
    `
})
console.log('gmc', gmc);

function onConfigInit() {
    // 如果没有配置地址, 在首页弹出配置页面
    if((!gmc.get('ARIA2_RPC')) && window.location.pathname == '/') {
        gmc.open();
        AriaEhSetting.style = iframeCss
        throw new Error("未设置ARIA2_RPC地址");
    }
    init()
}

const iframeCss = `
    width: 400px;
    height: 480px;
    border: 1px solid;
    border-radius: 4px;
    position: fixed;
    z-index: 9999;
`

GM_registerMenuCommand("设置", () => {
    gmc.open()
    AriaEhSetting.style = iframeCss
})


let ARIA2_CLIENT_ID = GM_getValue('ARIA2_CLIENT_ID', '');
if (!ARIA2_CLIENT_ID) {
    ARIA2_CLIENT_ID = "EH-" + new Date().getTime();
    GM_setValue("ARIA2_CLIENT_ID", ARIA2_CLIENT_ID);
}

const IS_TORRENT_PAGE = window.location.href.includes("gallerytorrents.php");
const IS_HATH_ARCHIVE_PAGE = window.location.href.includes("hath.network/archive");
const IS_GALLERY_DETAIL_PAGE = window.location.href.includes("/g/");

const STYLE = `
.aria2helper-box {
    height: 27px;
    line-height: 27px;
}
.aria2helper-button { }
.aria2helper-loading { }
.aria2helper-message { cursor: pointer;  }
.aria2helper-status {
    display: none;
    padding: 4px 4px;
    font-size: 12px;
    text-align: center;
    background: rgba(${IS_EX ? '0,0,0': '255,255,255'}, 0.6);
    margin: 4px 8px;
    border-radius: 4px;
    font-weight: normal;
    white-space: normal;
    box-shadow: 0 1px 3px rgb(0 0 0 / 30%);
}
.glname .aria2helper-status {
    margin: 4px 0px;
}
.gl3e .aria2helper-status {
    margin: 0px 4px;
    padding: 4px 4px;
    width: 112px !important;
    white-space: normal;
    box-sizing: border-box;
    text-align: center !important;
}
.gl3e .aria2helper-status span {
    display: block;
}
.gl1t .aria2helper-status{
    margin: 4px 4px;
}
`;


const ONE_CLICK_STYLE = `
.aria2helper-one-click {
    width: 15px;
    height: 15px;
    background: radial-gradient(#ffc36b,#c56a00);
    border-radius: 15px;
    border: 1px #666 solid;
    box-sizing: border-box;
    color: #ebeae9;
    text-align: center;
    line-height: 15px;
    cursor: pointer;
    user-select: none;
}
.aria2helper-one-click:hover {
    background: radial-gradient(#bf893b,#985200);
}
.aria2helper-one-click.bt {
    background: radial-gradient(#a2d04f,#5fb213);
}
.aria2helper-one-click.bt:hover {
    background: radial-gradient(#95cf2b,#427711);
}
.aria2helper-one-click i {
    font-style: initial;
    transform: scale(0.7);
    margin-left: -1.5px;
}
.gldown {
    width: 35px !important;
    display: flex;
    flex-direction: row;
    justify-content: space-between;
}
.gl3e>div:nth-child(6) {
    left: 45px;
}
.aria2helper-one-click svg circle {
    stroke: #fff !important;
    stroke-width: 15px !important;
}
.aria2helper-one-click svg {
    width: 10px;
    display: inline-block;
    height: 10px;
    padding-top: 1.3px;
}
.gsp .aria2helper-one-click {
    display: inline-block;
    margin-left: 8px;
    vertical-align: -1.5px;
}

#gd5 .g2 {
    position: relative;
}
#btList{
    display: none;
    background: #f00;
    width: 90%;
    position: absolute;
    border-radius: 4px;
    border: 1px;
    z-index: 999;
    padding: 8px 0;
    font-size: 12px;
    text-align: left;
    background: rgba(${IS_EX ? '0,0,0': '255,255,255'}, 0.6);
    border-radius: 4px;
    font-weight: normal;
    white-space: normal;
    box-shadow: 0 1px 3px rgb(0 0 0 / 30%);
    backdrop-filter: saturate(180%) blur(20px);
    font-size: 12px;
    width: max-content;
    margin-top: 8px;
}
.nowrap {
    white-space:nowrap;
}
#gmid #btList {
    right: 0;
    margin-top: 16px;
}
.gldown #btList{
    left: 0;
}
.gldown #btList table {
    max-width: 60vw;
}
.btListShow #btList{
    display: block;
}
#btList .bt-item {
    padding: 4px 8px;
}
#btList .bt-name {
    font-weight: bold;
}
#btList .quality {
    font-weight: bold;
}
#btList td span {
    display: inline-block;
    padding: 2px 4px;
    height: 16px;
    line-height: 16px;
}
#btList td span.quality {
    font-weight: bold;
    border-radius: 4px;
    background: ${IS_EX ? '#fff': '#5c0d12'};
    color:  ${IS_EX ? '#000': '#fff'};
}
#btList table {
    border-spacing:0;
    border-collapse:collapse;
    max-width: 80vw;
}
#btList tr th {
    padding-bottom: 8px;
    text-align: center;
}
#btList tr th span {
    font-weight: 400;
}
#btList tr td {
    padding: 2px 4px;
}
#btList tr:hover td {
    background: rgba(${IS_EX ? '0,0,0': '255,255,255'}, 0.6);
}
#btList tr>td:first-of-type, #btList tr>th:first-of-type {
    padding: 0 8px;
}
#btList tr>td:last-child, #btList tr>th:last-child {
    padding-right: 8px;
}
`;

const SVG_LOADING_ICON = `<svg style="margin: auto; display: block; shape-rendering: auto;" width="24px" height="24px" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid">
<circle cx="50" cy="50" fill="none" stroke="${IS_EX ? '#f1f1f1': '#5C0D11'}" stroke-width="10" r="35" stroke-dasharray="164.93361431346415 56.97787143782138">
  <animateTransform attributeName="transform" type="rotate" repeatCount="indefinite" dur="1s" values="0 50 50;360 50 50" keyTimes="0;1"></animateTransform>
</circle></svg>`;

const ARIA2_ERROR_MSG = {
    '2': '操作超时',
    '3': '无法找到指定资源',
    '4': "无法找到指定资源.",
    '5': "由于下载速度过慢, 下载已经终止.",
    '6': "网络问题",
    '8': "服务器不支持断点续传",
    '9': "可用磁盘空间不足",
    '10': "分片大小与 .aria2 控制文件中的不同.",
    '11': "aria2 已经下载了另一个相同文件.",
    '12': "aria2 已经下载了另一个相同哈希的种子文件.",
    '13': "文件已经存在.",
    '14': "文件重命名失败.",
    '15': "文件打开失败.",
    '16': "文件创建或删除已有文件失败.",
    '17': "文件系统出错.",
    '18': "无法创建指定目录.",
    '19': "域名解析失败.",
    '20': "解析 Metalink 文件失败.",
    '21': "FTP 命令执行失败.",
    '22': "HTTP 返回头无效或无法识别.",
    '23': "指定地址重定向过多.",
    '24': "HTTP 认证失败.",
    '25': "解析种子文件失败.",
    '26': '指定 ".torrent" 种子文件已经损坏或缺少 aria2 需要的信息.',
    '27': '指定磁链地址无效.',
    '28': '设置错误.',
    '29': '远程服务器繁忙, 无法处理当前请求.',
    '30': '处理 RPC 请求失败.',
    '32': '文件校验失败.'
};


class AriaClientLite {
    constructor(opt = {}) {
        this.rpc = opt.rpc;
        this.secret = opt.secret;
        this.id = opt.id;
    }

    async addUri(url, dir = '', extraOptions = null) {
        const response = await this.post(this.rpc, this._addUriParameter(url, dir, extraOptions));
        return this.singleResponseGuard(response);
    }

    async tellStatus(id) {
        const response = await this.post(this.rpc, this._tellStatusParameter(id));
        return this.singleResponseGuard(response);
    }

    async batchTellStatus(ids = []) {
        if(!ids.length) return [];
        const dataList = ids.map(id => this._tellStatusParameter(id));
        const response = await this.post(this.rpc, dataList);
        if(response.responseType !== 'json') throw `不支持的数据格式: ${response.status}`;
        const json = JSON.parse(response.responseText);
        if(!Array.isArray(json)) throw "批量请求数据结构错误";
        return json.map(v => v.result);
    }

    async multiCall(calls = []) {
        if(!calls.length) return [];
        const response = await this.post(this.rpc, calls);
        if(response.responseType !== 'json') throw `不支持的数据格式: ${response.status}`;
        const json = JSON.parse(response.responseText);
        if(!Array.isArray(json)) throw "批量请求数据结构错误";
        return json.map((item) => item?.result).filter(Boolean);
    }

    async batchTellActiveTorrents(limit = 16) {
        const paramsList = [];
        const offsets = [0];
        for (let i = 1; i < limit; i += 1) {
            offsets.push(i);
        }
        offsets.forEach((offset) => {
            paramsList.push(this._jsonRpcPack('aria2.tellActive', []));
            paramsList.push(this._jsonRpcPack('aria2.tellWaiting', [offset, 1]));
        });
        const results = await this.multiCall(paramsList);
        const tasks = results
            .flat()
            .filter((task) => task && /\.torrent$/i.test(task?.files?.[0]?.path || ''));
        const processed = tasks.map((task) => {
            const hash = task?.bittorrent?.info?.infoHash || '';
            const infoHash = hash || task.infoHash || '';
            return {
                ...task,
                infoHash,
            };
        });
        return processed;
    }

    request(url, opt={}) {
        return new Promise((resolve, reject) => {
            opt.onerror = (err) => {
                const message = err?.error || err?.message || '网络请求失败';
                reject(new Error(message));
            };
            opt.ontimeout = () => {
                reject(new Error('请求超时'));
            };
            opt.onload = resolve;
            GM_xmlhttpRequest({
                url,
                timeout: 2000,
                responseType: 'json',
                ...opt
            });
        })
    }

    post(url, data = {}) {
        return this.request(url, {
            method: "POST",
            data: JSON.stringify(data),
        });
    }

    singleResponseGuard(response) {
        if(response.responseType !== 'json') {
            throw `不支持的数据格式: ${response.status}`;
        }
        const json = JSON.parse(response.responseText);
        if(response.status !== 200 && json && json.error) throw `${json.error.code} ${json.error.message}`;
        if(response.status !== 200) throw `错误: ${response.status}`;
        return json.result;
    }

    _jsonRpcPack(method, params) {
        if (this.secret) params.unshift("token:" + this.secret);
        return {
            "jsonrpc": "2.0",
            "method": method,
            "id": ARIA2_CLIENT_ID,
            params
        }
    }

    _addUriParameter(url, dir = '', extraOptions = null) {
        const opt = {"follow-torrent": 'true', "pause": 'false'};
        if(dir) opt['dir'] = dir;
        if (extraOptions && typeof extraOptions === 'object') {
            Object.entries(extraOptions).forEach(([key, value]) => {
                if (value === undefined || value === null) return;
                opt[key] = String(value);
            });
        }
        return this._jsonRpcPack('aria2.addUri', [ [url], opt ]);
    }

    _tellStatusParameter(id) {
        return this._jsonRpcPack('aria2.tellStatus', [id]);
    }

}

class SendTaskButton {
    constructor(gid, link) {
        this.element = document.createElement("div");;
        this.link = link;
        this.gid = gid;

        this.element.className = "aria2helper-box";
        this.loading = document.createElement("div");
        this.loading.className = "aria2helper-loading";
        this.loading.innerHTML = SVG_LOADING_ICON;

        this.message = document.createElement("div");
        this.message.className = "aria2helper-message";

        this.button = document.createElement("input");
        this.button.type = "button";
        this.button.value = "发送到Aria2";
        this.button.className = 'stdbtn aria2helper-button';
        this.button.onclick = () => this.buttonClick();
        this.element.appendChild(this.button);
        this.element.appendChild(this.loading);
        this.element.appendChild(this.message);
        this.message.onclick = () => this.show(this.button);
        this.show(this.button);
    }

    show(node) {
        this.loading.style.display = 'none';
        this.message.style.display = 'none';
        this.button.style.display = 'none';
        node.style.display = '';
    }

    showMessage(msg) {
        this.message.textContent = msg;
        this.show(this.message);
    }
    showLoading() {
        this.show(this.loading);
    }

    async buttonClick() {
        if(!isRpcConfigured()) {
            this.showMessage('请先在设置中配置 ARIA2_RPC 地址');
            return;
        }
        this.showLoading();
        try {
            const id = await ariaClient.addUri(getTorrentLink(this.link), gmc.get('ARIA2_DIR'));
            Tool.setTaskId(this.gid, id);
            this.showMessage("成功");
        } catch (error) {
            console.error(error);
            if(typeof error === 'string') return this.showMessage(error || "请求失败");
            if(error.status) return this.showMessage("请求失败 HTTP" + error.status);
            const message = (error && error.message) || (typeof error === 'string' ? error : '请求失败');
            this.showMessage(message);
        }
    }
}

class TaskStatus {
    constructor(ehGid) {
        this.element = document.createElement("div");
        this.element.className = 'aria2helper-status'
        this.monitorCount = 0;
        this.ehGid = ehGid;
    }
    setStatus(task) {
        this.monitorCount ++;
        const statusBox = this.element;
        statusBox.style.display = 'block'
        const completedLength = parseInt(task.completedLength, 10) || 0;
        const totalLength = parseInt(task.totalLength, 10) || 0;
        const downloadSpeed = parseInt(task.downloadSpeed, 10) || 0;
        const uploadLength = parseInt(task.uploadLength, 10) || 0;
        const uploadSpeed = parseInt(task.uploadSpeed, 10) || 0;
        const connections = parseInt(task.connections, 10) || 0;
        const file = task.files[0];
        const filePath = file ? file.path : '';
        const name = filePath.split(/[\/\\]/).pop();
        // 显示扩展名 用于区分当前下载的是种子 还是文件。
        const ext = name.includes(".") ? name.split('.').pop() : '';

        let progress = '-';

        if(totalLength) {
            progress = (completedLength/totalLength * 100).toFixed(2) + '%';
        }

        // ⠓ ⠚ ⠕ ⠪
        const iconList = "⠓⠋⠙⠚".split("");
        const icon = iconList[this.monitorCount % iconList.length];
        let info = [];

        if (task.status === 'active') {
            if (task.verifyIntegrityPending) {
                info.push(`<b>${icon} 🔍 等待验证</b>`);
            } else if (task.verifiedLength) {
                info.push(`<b>${icon} 🔍 正在验证</b>`);
                if (task.verifiedPercent) {
                    info.push(`已验证 (${task.verifiedPercent})`);
                }
            } else if (task.seeder === true || task.seeder === 'true') {
                info.push(`<b>${icon} 📤 做种</b>`);
                info.push(`已上传：${Tool.fileSize(uploadLength)}`);
                info.push(`速度：${Tool.fileSize(uploadSpeed)}/s`);
            } else {
                info.push(`<b>${icon} 📥 下载中</b>`);
                info.push(`进度：${progress}`);
                info.push(`速度：${Tool.fileSize(downloadSpeed)}/s`);
            }
        } else if (task.status === 'waiting') {
            info.push(`<b>${icon} ⏳ 排队</b>`);
        } else if (task.status === 'paused') {
            info.push(`<b>${icon} ⏸ 暂停</b>`);
            info.push(`进度：${progress}`);
        } else if (task.status === 'complete') {
            info.push(`<b>${icon} ☑️ 完成</b>`);
        } else if (task.status === 'error') {
            const errorMessageCN = ARIA2_ERROR_MSG[task.errorCode]
            info.push(`<b>${icon} 错误</b> (${task.errorCode}: ${errorMessageCN || task.errorMessage || "未知错误"})`);
            info.push(`进度：${progress}`);
        } else if (task.status === 'removed') {
            info.push(`<b>${icon} ⛔️ 已删除</b>`);
        }

        info.push(`类型：${ext}`);

        statusBox.innerHTML = info.map(v => `<span>${v}</span>`).join(' ');

        if(task.followedBy && task.followedBy.length) {
            // BT任务跟随
            Tool.setTaskId(this.ehGid, task.followedBy[0]);
        }
    }

}

class Tool {


    static htmlDecodeByRegExp (str) {
        let temp = "";
        if(str.length == 0) return "";
        temp = str.replace(/&amp;/g,"&");
        temp = temp.replace(/&lt;/g,"<");
        temp = temp.replace(/&gt;/g,">");
        temp = temp.replace(/&nbsp;/g," ");
        temp = temp.replace(/&#39;/g,"\'");
        temp = temp.replace(/&quot;/g,"\"");
        return temp;
    }

    static addStyle(styles) {
        var styleSheet = document.createElement("style")
        styleSheet.innerText = styles
        document.head.appendChild(styleSheet)
    }

    static urlGetGId(url) {
        let m;
        m = /gid=(\d+)/i.exec(url);
        if(m) return parseInt(m[1], 10);
        m = /archive\/(\d+)\//i.exec(url);
        if(m) return parseInt(m[1], 10);
        m = /\/g\/(\d+)\//i.exec(url);
        if(m) return parseInt(m[1], 10);
    }

    static urlGetToken(url) {
        let m;
        m = /&t(oken)?=(\d+)/i.exec(url);
        if(m) return m[2];
        m = /\/g\/(\d+)\/(\w+)\//i.exec(url);
        if(m) return m[2];
    }

    static setTaskId(ehGid, ariaGid) {
        GM_setValue("task-" + ehGid, ariaGid);
    }

    static getTaskId(ehGid) {
        return GM_getValue("task-" + ehGid, 0);
    }

    static fileSize(_size, round = 2) {
        const divider = 1024;

        if (_size < divider) {
          return _size + ' B';
        }

        if (_size < divider * divider && _size % divider === 0) {
          return (_size / divider).toFixed(0) + ' KB';
        }

        if (_size < divider * divider) {
          return `${(_size / divider).toFixed(round)} KB`;
        }

        if (_size < divider * divider * divider && _size % divider === 0) {
          return `${(_size / (divider * divider)).toFixed(0)} MB`;
        }

        if (_size < divider * divider * divider) {
          return `${(_size / divider / divider).toFixed(round)} MB`;
        }

        if (_size < divider * divider * divider * divider && _size % divider === 0) {
          return `${(_size / (divider * divider * divider)).toFixed(0)} GB`;
        }

        if (_size < divider * divider * divider * divider) {
          return `${(_size / divider / divider / divider).toFixed(round)} GB`;
        }

        if (_size < divider * divider * divider * divider * divider &&
          _size % divider === 0) {
          const r = _size / divider / divider / divider / divider;
          return `${r.toFixed(0)} TB`;
        }

        if (_size < divider * divider * divider * divider * divider) {
          const r = _size / divider / divider / divider / divider;
          return `${r.toFixed(round)} TB`;
        }

        if (_size < divider * divider * divider * divider * divider * divider &&
          _size % divider === 0) {
          const r = _size / divider / divider / divider / divider / divider;
          return `${r.toFixed(0)} PB`;
        } else {
          const r = _size / divider / divider / divider / divider / divider;
          return `${r.toFixed(round)} PB`;
        }
    }

    static sanitizeFileName(name, fallback = 'archive') {
        const trimmed = (name || '').replace(/[\u0000-\u001f]+/g, '').trim();
        const cleaned = trimmed.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
        const result = cleaned || fallback;
        return result.length > 240 ? result.slice(0, 240).trim() : result;
    }

    static extractArchiveTitle(html) {
        if (!html) return '';
        const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        if (!match) return '';
        const text = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        return Tool.htmlDecodeByRegExp(text);
    }

    static buildArchiveFileName(title, dltype = 'org') {
        const safeTitle = Tool.sanitizeFileName(title || '', 'gallery');
        const base = safeTitle || 'gallery';
        const withExtension = base.toLowerCase().endsWith('.zip') ? base : `${base}.zip`;
        if (dltype === 'res' && !/resample|重采样|重採樣|重采樣|重新采样/i.test(withExtension)) {
            return withExtension.replace(/\.zip$/i, ' (Resample).zip');
        }
        return withExtension;
    }

    static extractArchiveFileNameFromDownload(html) {
        if (!html) return '';
        const strongMatch = html.match(/<strong[^>]*>([^<]*?\.zip)<\/strong>/i);
        if (strongMatch && strongMatch[1]) {
            return Tool.htmlDecodeByRegExp(strongMatch[1]);
        }
        return '';
    }

    static hexToDecimal(hex = '') {
        if(!hex) return '';
        try {
            return BigInt(`0x${hex}`).toString(10);
        } catch (error) {
            console.warn('十六进制转换失败', hex, error);
            return '';
        }
    }

}

class MonitorTask {
    constructor() {
        this.gids = [];
        this.taskIds = [];
        this.taskToGid = {};
        this.statusMap = {};
        this.timerId = 0;
        this.run = false;
    }

    start() {
        this.run = true;
        this.refreshTaskIds();
        this.loadStatus();
    }

    stop() {
        this.run = false;
        if(this.timerId)clearTimeout(this.timerId);
    }

    addGid(gid) {
        this.gids.push(gid);
        GM_addValueChangeListener("task-" + gid, () => {
            this.refreshTaskIds();
        });
        this.statusMap[gid] = new TaskStatus(gid);
        return this.statusMap[gid];
    }

    refreshTaskIds() {
        if(!this.gids.length) return;
        this.taskIds = this.gids.map(v => {
            const agid = Tool.getTaskId(v);
            if(agid) this.taskToGid[agid] = v;
            return agid;
        }).filter(v => v);
    }

    async loadStatus() {
        if(!this.run) return;
        let hasActive = false;
        try {
            const batch = await ariaClient.batchTellStatus(this.taskIds);
            const fallback = new Map();
            batch.forEach(task => {
                if(!task) return;
                const mapped = this.setStatusToUI(task);
                if(!mapped) fallback.set(task.gid, task);
                hasActive = hasActive || "active" === task.status;
            });
            if (!isRpcConfigured()) {
                this.scheduleNext(hasActive);
                return;
            }
            try {
                const torrentTasks = await ariaClient.batchTellActiveTorrents();
                torrentTasks.forEach((task) => {
                    if (!task) return;
                    const mapped = this.setStatusToUI(task);
                    if (!mapped && task.infoHash) {
                        const decimalGid = Tool.hexToDecimal(task.infoHash);
                        if (decimalGid && this.statusMap[decimalGid]) {
                            this.taskToGid[task.gid] = decimalGid;
                            this.setStatusToUI({ ...fallback.get(task.gid), ...task, gid: task.gid });
                        }
                    }
                });
            } catch (err) {
                console.warn('获取种子任务状态失败', err);
            }
        } catch (error) {
            console.error(error);
        }
        this.scheduleNext(hasActive);
    }

    scheduleNext(hasActive) {
        this.timerId = setTimeout(() => {
            this.loadStatus();
        }, hasActive ? 500 : 5000);
    }

    setStatusToUI(task) {
        if(!task) return false;
        const gid = this.taskToGid[task.gid];
        if(!gid) return false;
        const ui = this.statusMap[gid];
        if(!ui) return false;
        ui.setStatus(task);
        return true;
    }
}

const GID = Tool.urlGetGId(window.location.href);
const TOKEN = Tool.urlGetToken(window.location.href);

let ariaClient;

const isRpcConfigured = () => {
    const rpc = (gmc.get('ARIA2_RPC') || '').trim();
    return Boolean(rpc);
};

const EXPOSE_TARGET = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

const ensureAriaClient = () => {
    if (!isRpcConfigured()) {
        throw new Error('ARIA2_RPC 未配置');
    }
    if (!ariaClient) {
        ariaClient = new AriaClientLite({
            rpc: gmc.get('ARIA2_RPC'),
            secret: gmc.get('ARIA2_SECRET'),
            id: ARIA2_CLIENT_ID,
        });
    }
    return ariaClient;
};

if (GID || TOKEN) {
    console.log('[AriaEh]', { GID, TOKEN });
}

const ARIA_EH_BRIDGE_VERSION = '1.0.0';

const AriaEhBridge = {
    version: ARIA_EH_BRIDGE_VERSION,
    isConfigured: () => isRpcConfigured(),
    getPreferences: () => ({
        useMagnet: Boolean(gmc.get('USE_MAGNET')),
        replaceExTorrentUrl: Boolean(gmc.get('REPLACE_EX_TORRENT_URL')),
        rpc: (gmc.get('ARIA2_RPC') || '').trim(),
        dir: gmc.get('ARIA2_DIR') || '',
    }),
    prepareDownloadTarget(task = {}) {
        if (!task) return null;
        const preferMagnet = Boolean(gmc.get('USE_MAGNET'));
        const ensureUri = (uri) => (typeof uri === 'string' ? uri.trim() : '');
        const magnetCandidate = ensureUri(task.magnet || task.magnetHref || task.uri || '');
        const torrentCandidateRaw = task.torrent || task.torrentHref || task.link || '';
        const torrentCandidate = ensureUri(torrentCandidateRaw);
        const convertTorrent = (value) => {
            if (!value) return '';
            return ensureUri(getTorrentLink(value));
        };
        const toType = (uri) => (uri.toLowerCase().startsWith('magnet:') ? 'magnet' : 'torrent');

        if (preferMagnet) {
            if (magnetCandidate) return { uri: magnetCandidate, type: toType(magnetCandidate) };
            if (torrentCandidate) {
                const converted = convertTorrent(torrentCandidate);
                if (converted) return { uri: converted, type: toType(converted) };
            }
        } else {
            if (torrentCandidate) {
                const converted = convertTorrent(torrentCandidate);
                if (converted) return { uri: converted, type: toType(converted) };
            }
            if (magnetCandidate) return { uri: magnetCandidate, type: toType(magnetCandidate) };
        }

        if (magnetCandidate) return { uri: magnetCandidate, type: toType(magnetCandidate) };
        if (torrentCandidate) {
            const converted = convertTorrent(torrentCandidate);
            if (converted) return { uri: converted, type: toType(converted) };
        }
        const fallback = ensureUri(task.uri || '');
        if (fallback) return { uri: fallback, type: toType(fallback) };
        return null;
    },
    async enqueueTasks(tasks = []) {
        if (!Array.isArray(tasks)) throw new Error('任务格式错误');
        if (!tasks.length) return [];
        if (!isRpcConfigured()) throw new Error('ARIA2_RPC 未配置');

        const client = ensureAriaClient();
        const dir = gmc.get('ARIA2_DIR') || '';
        const results = [];

        for (let i = 0; i < tasks.length; i += 1) {
            const task = tasks[i] || {};
            try {
                let target = null;
                let extraOptions = null;
                let archiveMeta = null;
                if (task.archive) {
                    const archive = task.archive || {};
                    const archiveGid = archive.gid || task.gid || '';
                    let archiveToken = archive.token || task.token || '';
                    if (!archiveToken) {
                        const tokenSource = archive.pageLink || archive.pageUrl || task.pageLink || '';
                        if (tokenSource) {
                            archiveToken = Tool.urlGetToken(tokenSource) || '';
                        }
                    }
                    const archiveInfo = await fetchArchiveDownloadInfo({
                        gid: archiveGid,
                        token: archiveToken,
                        dltype: archive.dltype || task.dltype,
                        archiverLink: archive.archiverLink || archive.archiverUrl || '',
                        pageLink: archive.pageLink || archive.pageUrl || task.pageLink || '',
                        fileName: archive.fileName || task.name || '',
                    });
                    target = {
                        uri: archiveInfo.downloadUrl,
                        type: 'archive',
                    };
                    if (archiveInfo.fileName) {
                        extraOptions = { out: archiveInfo.fileName };
                    }
                    archiveMeta = {
                        gid: archiveGid,
                        info: archiveInfo,
                    };
                }
                if (!target && task.uri) {
                    const uri = String(task.uri).trim();
                    if (uri) {
                        target = {
                            uri,
                            type: task.type || (uri.toLowerCase().startsWith('magnet:') ? 'magnet' : 'torrent'),
                        };
                    }
                }
                if (!target) {
                    target = AriaEhBridge.prepareDownloadTarget(task);
                }
                if (!target || !target.uri) {
                    results.push({
                        success: false,
                        error: '无可用链接',
                        gid: task.gid,
                        index: i,
                    });
                    continue;
                }
                const taskId = await client.addUri(target.uri, dir, extraOptions);
                const gidForRecord = archiveMeta?.gid || task.gid;
                const numericGid = Number.parseInt(gidForRecord, 10);
                if (!Number.isNaN(numericGid)) {
                    Tool.setTaskId(numericGid, taskId);
                }
                if (archiveMeta && !Number.isNaN(numericGid)) {
                    const archiveTask = task.archive || {};
                    dispatchGalleryDownloaded(numericGid, {
                        source: 'batch-archive',
                        fileName: archiveMeta.info.fileName,
                        dltype: archiveMeta.info.dltype,
                        token: archiveTask.token || task.token || '',
                        href: archiveTask.pageLink || archiveTask.pageUrl || task.pageLink || '',
                    });
                }
                results.push({
                    success: true,
                    taskId,
                    gid: gidForRecord,
                    uri: target.uri,
                    type: target.type || (target.uri.toLowerCase().startsWith('magnet:') ? 'magnet' : 'torrent'),
                    index: i,
                    fileName: archiveMeta?.info?.fileName,
                });
            } catch (error) {
                const message = (error && error.message) || String(error || '提交失败');
                results.push({
                    success: false,
                    error: message,
                    gid: task.gid,
                    index: i,
                });
            }
        }

        return results;
    },
};

if (EXPOSE_TARGET) {
    const existingApi = EXPOSE_TARGET.AriaEhAPI || {};
    const merged = Object.assign(existingApi, AriaEhBridge);
    merged.version = ARIA_EH_BRIDGE_VERSION;
    EXPOSE_TARGET.AriaEhAPI = merged;
    if (!merged.__bridgeReady) {
        merged.__bridgeReady = true;
        try {
            EXPOSE_TARGET.dispatchEvent(new CustomEvent('AriaEh:bridge-ready', { detail: { version: merged.version } }));
        } catch (err) {
            console.warn('AriaEh bridge ready event failed', err);
        }
    }
}

function dispatchGalleryDownloaded(gid, detail = {}) {
    const numeric = Number.parseInt(gid, 10);
    if (!numeric) return;
    try {
        const eventDetail = { gid: numeric, ...detail };
        window.dispatchEvent(new CustomEvent('EhAria2:gallery-downloaded', { detail: eventDetail }));
    } catch (err) {
        console.warn('广播画廊下载状态失败', err);
    }
}

function normalizeDlType(value) {
    const text = (value || '').toString().toLowerCase();
    if (text.startsWith('res')) return 'res';
    return 'org';
}

async function deriveArchiverLinkFromPage(pageLink) {
    if (!pageLink) return '';
    try {
        const html = await fetch(pageLink, { credentials: 'include' }).then((v) => v.text());
        const match = html.match(/'(https:\/\/[\w.-]+\/archiver\.php[^']+)'/i);
        if (match && match[1]) {
            return Tool.htmlDecodeByRegExp(match[1]).replace('--', '-');
        }
    } catch (err) {
        console.warn('获取存档链接失败', err);
    }
    return '';
}

async function fetchArchiveDownloadInfo({ gid, token, dltype, archiverLink, pageLink, fileName }) {
    const normalizedType = normalizeDlType(dltype);
    let resolvedArchiverLink = archiverLink || '';
    if (!resolvedArchiverLink) {
        if (gid && token) {
            const base = pageLink && pageLink.includes('exhentai.org')
                ? 'https://exhentai.org'
                : (IS_EX ? 'https://exhentai.org' : 'https://e-hentai.org');
            resolvedArchiverLink = `${base}/archiver.php?gid=${gid}&token=${token}`;
        } else if (pageLink) {
            resolvedArchiverLink = await deriveArchiverLinkFromPage(pageLink);
        }
    }
    if (!resolvedArchiverLink) {
        if (pageLink) {
            resolvedArchiverLink = await deriveArchiverLinkFromPage(pageLink);
        }
    }
    if (!resolvedArchiverLink) {
        throw new Error('未找到存档链接');
    }

    const formData = new FormData();
    formData.append('dltype', normalizedType);
    formData.append('dlcheck', 'Download Original Archive');
    const archiverHtml = await fetch(resolvedArchiverLink, {
        method: 'POST',
        credentials: 'include',
        body: formData,
    }).then((v) => v.text());
    const downloadLinkMatch = archiverHtml.match(/"(https?:\/\/[^"]+?\.hath\.network\/archive[^"]*)"/i);
    if (!downloadLinkMatch || !downloadLinkMatch[1]) {
        throw new Error('未找到存档下载地址');
    }
    const rawUrl = downloadLinkMatch[1];
    const downloadUrl = rawUrl.includes('?start=')
        ? rawUrl
        : `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}start=1`;
    const title = Tool.extractArchiveTitle(archiverHtml);
    let fileNameCandidate = (fileName || '').trim();
    if (fileNameCandidate && fileNameCandidate.toLowerCase() === 'gallery.zip' && title) {
        fileNameCandidate = Tool.buildArchiveFileName(title, normalizedType);
    }
    if (!fileNameCandidate) {
        try {
            const downloadPageHtml = await fetch(downloadUrl, { credentials: 'include' }).then((v) => v.text());
            fileNameCandidate = Tool.extractArchiveFileNameFromDownload(downloadPageHtml);
        } catch (err) {
            console.warn('获取存档文件名失败', err);
        }
    }
    const fallbackName = Tool.buildArchiveFileName(title, normalizedType);
    const sanitizedName = Tool.sanitizeFileName(fileNameCandidate || fallbackName, fallbackName);
    const resolvedFileName = sanitizedName.toLowerCase().endsWith('.zip') ? sanitizedName : `${sanitizedName}.zip`;
    return {
        downloadUrl,
        fileName: resolvedFileName,
        title,
        dltype: normalizedType,
    };
}


function oneClickButton(gid, pageLink, archiverLink) {
    const oneClick = document.createElement('div');
    oneClick.textContent = "🡇";
    oneClick.title = "[Aria2] 一键下载";
    oneClick.classList.add("aria2helper-one-click");
    let loading = false;
    oneClick.onclick = async () => {
        if(!isRpcConfigured()) {
            alert('请先在设置中配置 ARIA2_RPC 地址');
            return;
        }
        if(loading === true) return;
        oneClick.innerHTML = SVG_LOADING_ICON;
        loading = true;
        try {
            const selectedType = gmc.get('ONE_CLICK_DOWNLOAD_DLTYPE').slice(0, 3);
            const token = pageLink ? Tool.urlGetToken(pageLink) : null;
            const info = await fetchArchiveDownloadInfo({
                gid,
                token,
                dltype: selectedType,
                archiverLink,
                pageLink,
            });
            const client = ensureAriaClient();
            const extra = info.fileName ? { out: info.fileName } : null;
            const taskId = await client.addUri(info.downloadUrl, gmc.get('ARIA2_DIR'), extra);
            Tool.setTaskId(gid, taskId);
            dispatchGalleryDownloaded(gid, {
                source: 'one-click-archive',
                fileName: info.fileName,
                dltype: info.dltype,
                token,
                href: pageLink || '',
            });
            oneClick.innerHTML = "✔";
            setTimeout(() => {
                oneClick.innerHTML = "🡇";
            }, 2000);
        } catch (error) {
            const message = (error && error.message) || (typeof error === 'string' ? error : '请求失败');
            alert("一键下载失败:" + message);
            oneClick.innerHTML = "🡇";
        }
        loading = false;
    }
    return oneClick;
}

function injectListOneClickButtons(root = document) {
    const rows = [];
    if (root instanceof HTMLElement) {
        if (root.matches('.itg tr') || root.classList.contains('gl1t')) {
            rows.push(root);
        }
    }
    if (typeof root.querySelectorAll === 'function') {
        root.querySelectorAll('.itg tr, .itg .gl1t').forEach((node) => rows.push(node));
    }
    rows.forEach((tr) => {
        let anchor = tr.querySelector('.glname a, .gl1e a, .gl1t');
        if (tr.classList && tr.classList.contains('gl1t')) {
            anchor = tr.querySelector('a');
        }
        if (!anchor) return;
        const link = anchor.href;
        const gid = Tool.urlGetGId(link);
        if (!gid) return;
        const gldown = tr.querySelector('.gldown');
        if (!gldown || gldown.querySelector('.aria2helper-one-click')) return;
        gldown.appendChild(oneClickButton(gid, link, null));
    });
}

let listOneClickObserver = null;
function setupListOneClickObserver() {
    if (listOneClickObserver || !document.querySelector('.itg')) return;
    listOneClickObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                handleAddedListNode(node);
            });
        });
    });
    listOneClickObserver.observe(document.querySelector('.itg'), { childList: true, subtree: true });
}

function handleAddedListNode(node) {
    if (!node) return;
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        node.childNodes.forEach((child) => handleAddedListNode(child));
        return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.matches('.itg tr') || node.classList.contains('gl1t') || node.querySelector('.gldown')) {
        injectListOneClickButtons(node);
    }
}


async function getTorrentList(gid, token, lifeTime = 0) {
    const html = await fetch(`${document.location.origin}/gallerytorrents.php?gid=${gid}&t=${token}`, {credentials: "include"}).then(v => v.text());
    const safeHtml = html.replace(/^.*<body>(.*)<\/body>.*$/igms,"$1").replace(/<script.*?>(.*?)<\/script>/igms, '');
    const dom = document.createElement('div')
    dom.innerHTML = safeHtml;
    const formList = [...dom.querySelectorAll("form")];
    const list = formList.map((e, i) => {
        const link = e.querySelector("table > tbody > tr:nth-child(3) > td > a");
        if(!link) return null;
        const linkHref = getTorrentLinkFromAnchor(link);
        if(!linkHref) return null;
        const posted = e.querySelector("table > tbody > tr:nth-child(1) > td:nth-child(1)");
        const size = e.querySelector("table > tbody > tr:nth-child(1) > td:nth-child(2)");
        const seeds = e.querySelector("table > tbody > tr:nth-child(1) > td:nth-child(4)");
        const peers = e.querySelector("table > tbody > tr:nth-child(1) > td:nth-child(5)");
        const downloads = e.querySelector("table > tbody > tr:nth-child(1) > td:nth-child(6)");
        const uploader = e.querySelector("table > tbody > tr:nth-child(2) > td:nth-child(1)");
        const getNumber = (text = '') => parseFloat((text.match(/[\d\.]+/) || [0])[0]);
        const getValueText = (text = '') => (text.match(/:(.*)/) || ['',''])[1].trim();
        const sizeText = getValueText(size.textContent);
        const sizeNumber = getNumber(sizeText);
        const unit = [sizeText.match(/[KMGT]i?B/) || ['']][0];
        const magnification = {
            "KB": 1000,
            "MB": 1000 * 1000,
            "GB": 1000 * 1000 * 1000,
            "TB": 1000 * 1000 * 1000 * 1000,
            "KiB": 1024,
            "MiB": 1024 * 1024,
            "GiB": 1024 * 1024 * 1024,
            "TiB": 1024 * 1024 * 1024 * 1024,
        }
        if(!magnification[unit]) {
            console.warn("未知单位: ", unit, size);
        }
        let bytes = magnification[unit] ? sizeNumber * magnification[unit] : -1;
        const time = new Date(getValueText(posted.textContent));
        return {
            index: i,
            time: time,
            readableTime: dateStr(time),
            size: sizeText,
            bytes: bytes,
            seeds: getNumber(seeds.textContent), // 做种
            peers: getNumber(peers.textContent), // 下载中
            downloads: getNumber(downloads.textContent), // 完成
            user: getValueText(uploader.textContent),
            name: link.textContent,
            link: linkHref,
            achievements: new Set(),
        }
    }).filter(v => v);

    let maxBytes = 0;
    let maxTime = 0;
    let maxSeeds = 0;
    let maxPeers = 0;
    let maxDownloads = 0;
    list.forEach(v => {
        maxBytes = Math.max(maxBytes, v.bytes);
        maxTime = Math.max(maxTime, v.time.getTime());
        maxSeeds = Math.max(maxSeeds, v.seeds);
        maxPeers = Math.max(maxPeers, v.peers);
        maxDownloads = Math.max(maxDownloads, v.downloads);
    });
    list.forEach(v => {
        const time = v.time.getTime();
        if(v.bytes == maxBytes) v.achievements.add("size");
        if(time == maxTime) v.achievements.add("time");
        if(v.seeds == maxSeeds && maxSeeds > 0) v.achievements.add("seeds");
        if(v.peers == maxPeers && maxPeers > 0) v.achievements.add("peers");
        if(v.downloads == maxDownloads && maxDownloads > 0) v.achievements.add("downloads");
        if(time < lifeTime) v.achievements.add("overdue");
    });

    list.sort((a,b) => {
        return b.time.getTime() - a.time.getTime();
    })

    console.log('list', list);
    return list;
}

function dateStr(date = new Date()){
    const today = new Date();
    const now = today.getTime();
    const time = Math.floor((now - date.getTime())/1000) + ( today.getTimezoneOffset() * 60);
    if(time <= 60){
        return '刚刚';
    }else if(time<=60*60){
        return Math.floor(time/60)+"分钟前";
    }else if(time<=60*60*24){
        return  Math.floor(time/60/60)+"小时前";
    }else if(time<=60*60*24*7) {
        return Math.floor(time/60/60/24) + "天前";
    }else if(time<=60*60*24*7*4) {
        return Math.floor(time/60/60/24/7) + "周前";
    }else if(time<=60*60*24*365) {
        return (date.getMonth()+1).toString().padStart(2, '0')+"月"+date.getDate().toString().padStart(2, '0')+"日"
    }
    return date.getFullYear()+'年';
}

async function torrentsPopDetail(btButtonBox, gid = GID, token = TOKEN, buttonLeft = false, twoLines = false) {
    if(!btButtonBox) {
        btButtonBox = document.querySelector('#gd5 .g2:nth-child(3)');
    }
    if(btButtonBox) {
        boxA = btButtonBox.querySelector('a');
        boxA.onmouseenter = async () => {
            let btListBox = btButtonBox.querySelector('#btList');
            btButtonBox.classList.add('btListShow');
            if(!btListBox) {
                btListBox = document.createElement("div");
                btListBox.id = 'btList';
                btButtonBox.appendChild(btListBox);
                btListBox.innerHTML = SVG_LOADING_ICON;
                try {
                    const torents = await getTorrentList(gid, token);
                    if(torents.length) {
                        const achievement = (item, name) => item.achievements.has(name) ? 'quality' : '';
                        let th = '';
                        if(twoLines) {
                            th = `
                            <th>名称</th>
                            <th>体积</th>
                            <th>时间</th>
                            <th><span title="正在做种 Seeds">📤</span></th>
                            <th><span title="正在下载 Peers">📥</span></th>
                            <th><span title="下载完成 Downloads">✔️</span></th>`;
                        }else {
                            th = `
                            ${buttonLeft ? "<th></th><th></th>" : ""}
                            <th>名称</th>
                            <th>体积</th>
                            <th>时间</th>
                            <th><span title="正在做种 Seeds">📤</span></th>
                            <th><span title="正在下载 Peers">📥</span></th>
                            <th><span title="下载完成 Downloads">✔️</span></th>`;
                        }


                        btListBox.innerHTML = `<table>
                        <tr>
                        ${th}
                        </tr>
                        ${
                            torents.map(item => {

                                const button1 = `<td class="bt-button nowrap"><div data-link="${item.link}" data-gid="${gid}" class="aria2helper-one-click bt-download-button bt ">🡇</div></td>`;
                                const button2 = `<td class="bt-button nowrap"><div data-link="${item.link}" data-gid="${gid}" class="aria2helper-one-click bt-copy-button icon bt ">✂</div></td>`;
                                    const nameHtml = `<td class="bt-name"><a href="${item.link}">${item.name}</a></td>`;
                                    const infoHtml = `<td class="bt-size nowrap"><span class="${achievement(item, 'size')}">${item.size}</span></td>
                                    <td class="bt-time nowrap"><span title="${item.time.toLocaleString()}" class="${achievement(item, 'time')}">${item.readableTime}</span></td>
                                    <td class="bt-seeds nowrap"><span class="${achievement(item, 'seeds')}">${item.seeds}</span></td>
                                    <td class="bt-peers nowrap"><span class="${achievement(item, 'peers')}">${item.peers}</span></td>
                                    <td class="bt-downloads nowrap"><span class="${achievement(item, 'downloads')}">${item.downloads}</span></td>`;
                                    if(twoLines) {
                                        return `
                                <tr class="bt-item no-hover">
                                    ${nameHtml}
                                </tr>
                                <tr class="bt-item">
                                    ${button1 + button2}
                                    ${infoHtml}
                                </tr>
                                `;
                                    }
                                return `
                                <tr class="bt-item">
                                    ${buttonLeft ? button1 + button2 : ''}
                                    ${nameHtml}
                                    ${infoHtml}
                                    ${buttonLeft ? '' :  button2 + button1 }
                                </tr>
                                `
                            }).join('')
                        }</table>`;

                        btListBox.onclick = async (event) => {
                            const actionTarget = event.target.closest('.bt-download-button, .bt-copy-button');
                            if (!actionTarget) return;

                            if(actionTarget.classList.contains("bt-download-button")) {
                                const link = actionTarget.dataset.link;
                                const gid = parseInt(actionTarget.dataset.gid, 10);
                                if(!isRpcConfigured()) {
                                    alert('请先在设置中配置 ARIA2_RPC 地址');
                                    return;
                                }
                                if(actionTarget.dataset.loading === 'true') return;
                                actionTarget.innerHTML = SVG_LOADING_ICON;
                                actionTarget.dataset.loading = 'true';
                                try {
                                    const taskId = await ariaClient.addUri(getTorrentLink(link), gmc.get('ARIA2_DIR'));
                                    Tool.setTaskId(gid, taskId);
                                    actionTarget.innerHTML = "✔";
                                    setTimeout(() => {
                                        actionTarget.innerHTML = "🡇";
                                    }, 2000);
                                } catch (error) {
                                    const message = (error && error.message) || (typeof error === 'string' ? error : '请求失败');
                                    alert("一键下载失败:" + message);
                                    actionTarget.innerHTML = "🡇";
                                }
                                actionTarget.dataset.loading = 'false';
                                return;
                            }

                            if(actionTarget.classList.contains("bt-copy-button")) {
                                const link = actionTarget.dataset.link;
                                const magnet = torrentLink2magnet(link);
                                if (magnet) {
                                    GM_setClipboard(magnet);
                                    actionTarget.innerHTML = "✔";
                                    setTimeout(() => {
                                        actionTarget.innerHTML = "✂";
                                    }, 2000);
                                }
                            }
                        };
                    }else {
                        btListBox.innerHTML = "没有可用种子"
                    }
                } catch (error) {
                    btListBox.innerHTML = error.message;
                }
            }
        }
        btButtonBox.onmouseleave = () => {
            btButtonBox.classList.remove('btListShow');
        }
    }
}

function getTorrentInfo(link) {
    let match = link.match(/\/(\d+)\/([0-9a-f]{40})/i);
    if(!match) return;
    return {
        hash: match[2],
        trackerId: match[1],
    }
}

function torrentLink2magnet (link) {
    const info = getTorrentInfo(link);
    if(!info) return;
    return `magnet:?xt=urn:btih:${info.hash}&tr=${encodeURIComponent(`http://ehtracker.org/${info.trackerId}/announce`)}`;
}

function torrentLinkForceEhTracker (link) {
    const info = getTorrentInfo(link);
    if(!info) return;
    return `https://ehtracker.org/get/${info.trackerId}/${info.hash}.torrent`;
}

function getTorrentLink(link) {
    if(gmc.get('USE_MAGNET')) {
        return torrentLink2magnet(link) || link;
    }
    if(link.includes('exhentai.org') && gmc.get('REPLACE_EX_TORRENT_URL')) {
        return torrentLinkForceEhTracker(link) || link;
    }
    return link;
}

function getTorrentLinkFromAnchor(anchor) {
    if(!anchor) return '';
    const href = anchor.getAttribute('href') || '';
    if(href && href !== '#') return href;
    const onclick = anchor.getAttribute('onclick') || '';
    if(!onclick) return '';
    const match = onclick.toString().match(/['"](https?:\/\/[^'"\s]+\.torrent[^'"\s]*)['"]/i);
    if(match) return match[1];
    const popupMatch = onclick.toString().match(/popUp\(['"]([^'"]+)['"]/i);
    if(popupMatch) return Tool.htmlDecodeByRegExp(popupMatch[1]);
    return '';
}


function init() {
    ariaClient = new AriaClientLite({rpc: gmc.get('ARIA2_RPC'), secret: gmc.get('ARIA2_SECRET'), id: ARIA2_CLIENT_ID});
    Tool.addStyle(STYLE);
    Tool.addStyle(ONE_CLICK_STYLE);

    const monitorTask = new MonitorTask();
    if(GID) {

        // button
        if(IS_TORRENT_PAGE) {
            let tableList = document.querySelectorAll("#torrentinfo form table");
            if(tableList && tableList.length){
                tableList.forEach(function (table) {
                    let insertionPoint = table.querySelector('input[type="submit"],button[type="submit"]');
                    if(!insertionPoint)return;
                    let a = table.querySelector('a');
                    if(!a) return;
                    const rawLink = a.href || a.getAttribute('data-orig-href') || getTorrentLinkFromAnchor(a) || '';
                    if(!rawLink) return;
                    const button = new SendTaskButton(GID, rawLink);
                    insertionPoint.parentNode.insertBefore(button.element, insertionPoint);
                });
            }
        }

        if (IS_HATH_ARCHIVE_PAGE) {
            let insertionPoint = document.querySelector("#db a");
            if(!insertionPoint)return;
            const link = insertionPoint.href;
            const button = new SendTaskButton(GID, link);
            button.element.style.marginTop = '16px';
            insertionPoint.parentNode.insertBefore(button.element, insertionPoint);
        }

        // 状态监听
        const taskStatusUi = monitorTask.addGid(GID);
        if (IS_HATH_ARCHIVE_PAGE && gmc.get('USE_HATH_ARCHIVE_TASK_STATUS')) {
            taskStatusUi.element.style.marginTop = '8px';
            const insertionPoint = document.querySelector('#db strong');
            if(insertionPoint) insertionPoint.parentElement.insertBefore(taskStatusUi.element, insertionPoint.nextElementSibling);
        }
        if (IS_GALLERY_DETAIL_PAGE && gmc.get('USE_GALLERY_DETAIL_TASK_STATUS')) {
            const insertionPoint = document.querySelector('#gd2');
            if(insertionPoint) insertionPoint.appendChild(taskStatusUi.element);
        }
        if (IS_TORRENT_PAGE && gmc.get('USE_TORRENT_TASK_STATUS')) {
            const insertionPoint = document.querySelector('#torrentinfo p');
            if(insertionPoint) insertionPoint.parentElement.insertBefore(taskStatusUi.element, insertionPoint.nextElementSibling);
        }
        if(IS_GALLERY_DETAIL_PAGE && gmc.get('USE_TORRENT_POP_LIST')) {
            torrentsPopDetail();
        }
    } else if(gmc.get('USE_LIST_TASK_STATUS')) {
        const trList = document.querySelectorAll(".itg tr, .itg .gl1t");
        if(trList && trList.length) {
            const insertionPointMap = {};
            let textAlign = 'left';
            trList.forEach(function (tr) {
                let glname = tr.querySelector(".gl3e, .glname");
                let a = tr.querySelector(".glname a, .gl1e a, .gl1t");
                if(tr.classList.contains('gl1t')) {
                    glname = tr;
                    a = tr.querySelector('a');
                    textAlign = 'center';
                }
                if(!(glname && a)) return;
                const gid = Tool.urlGetGId(a.href);
                const token = Tool.urlGetToken(a.href);
                insertionPointMap[gid] = glname;
                const statusUI = monitorTask.addGid(gid);
                statusUI.element.style.textAlign = textAlign;
                glname.appendChild(statusUI.element);

                const listTypeDom = document.querySelector("#dms select > option[selected]");
                const listType = listTypeDom ? listTypeDom.value : '';
                if(listType == 't') return; // 暂时不支持缩略图模式,显示问题
                const gldown = tr.querySelector(".gldown");
                const torrentImg = gldown.querySelector('img');
                const torrentImgSrc = torrentImg.attributes.getNamedItem('src').value
                const hasTorrent = torrentImgSrc.includes("g/t.png");
                if(gmc.get('USE_TORRENT_POP_LIST') && hasTorrent) {
                    torrentsPopDetail(gldown, gid, token, true, listType == 't');
                }
            });
        }
    }


    monitorTask.start();

    if(gmc.get('USE_ONE_CLICK_DOWNLOAD')) {
        injectListOneClickButtons(document);
        setupListOneClickObserver();
        if(IS_GALLERY_DETAIL_PAGE) {
            const gldown = document.querySelector(".g2.gsp");
            const a = document.querySelector(".g2.gsp a");
            const archiverLinkMatch = /'(https:\/\/e.hentai\.org\/archiver\.php?.*?)'/i.exec(a.onclick.toString());
            const archiverLink = Tool.htmlDecodeByRegExp(archiverLinkMatch[1]).replace("--", "-");
            gldown.appendChild(oneClickButton(GID, null, archiverLink));
        }
    }

}
