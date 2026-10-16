'use strict';
// GIX GPU: wraps the gix-devjob flow (see gix-devcontainer README) in a few buttons.
// Runs on the laptop ("ui" extension), also while a remote window is open.
//   Sign in   -> SSH key + ~/.ssh/config block + key installed on gix-login (password once)
//   Start     -> pick a recent project / folder / git repo, get a GPU (preferring the node the
//                project was on), make sure the folder exists, open it over Remote-SSH
//   Release   -> scancel of the user's devc-<netid> job
//   Status bar polls squeue on gix-login.

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOGIN = 'gix-login';
const GPU = 'gix-gpu';
const BEGIN = '# >>> GIX GPU (managed by the GIX GPU VS Code extension; edit its settings instead) >>>';
const END = '# <<< GIX GPU <<<';
const SSH_DIR = path.join(os.homedir(), '.ssh');
const KEY = path.join(SSH_DIR, 'gix_ed25519');
const SSH_CONFIG = path.join(SSH_DIR, 'config');
const IS_WIN = process.platform === 'win32';

let ctx;
let statusItem;
let panel;
let pollTimer;
let lastStatus = { kind: 'unknown' };

function cfg() {
    return vscode.workspace.getConfiguration('gix');
}

// Windows ships OpenSSH in System32 but it isn't always on PATH for GUI apps.
function exe(name) {
    if (IS_WIN) {
        const p = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', name + '.exe');
        if (fs.existsSync(p)) return p;
    }
    return name;
}

function run(file, args, timeoutMs = 20000) {
    return new Promise((resolve) => {
        cp.execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

function sshBatch(host, remoteCmd, timeoutMs = 20000, extraOpts = []) {
    // Through the ProxyCommand, ConnectTimeout also covers gix-devjob waiting for Slurm
    // (11 s for a fresh job, minutes when the queue is full), so gix-gpu gets the long one.
    const connectTimeout = host === GPU ? '660' : '10';
    return run(exe('ssh'), ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${connectTimeout}`, ...extraOpts, host, remoteCmd], timeoutMs);
}

// ---------- ssh config ----------

function checked(value, re, name) {
    const v = String(value ?? '').trim();
    if (v && !re.test(v)) throw new Error(`GIX GPU setting "${name}" has an invalid value: ${v}`);
    return v;
}

function proxyCommand(extraEnv = []) {
    const c = cfg();
    const env = [...extraEnv];
    const node = checked(c.get('node'), /^[A-Za-z0-9.-]+$/, 'node');
    const gres = checked(c.get('gres'), /^[A-Za-z0-9_:]+$/, 'gres');
    const mem = checked(c.get('mem'), /^[0-9]+[KMGT]?$/, 'mem');
    const time = checked(c.get('time'), /^[0-9:-]+$/, 'time');
    const cpus = Number(c.get('cpus'));
    const idle = Number(c.get('idleMinutes'));
    if (node) env.push(`GIX_NODE=${node}`);
    if (gres) env.push(`GIX_GRES=${gres}`);
    if (mem) env.push(`GIX_MEM=${mem}`);
    if (time) env.push(`GIX_TIME=${time}`);
    if (Number.isInteger(cpus) && cpus > 0) env.push(`GIX_CPUS=${cpus}`);
    if (Number.isInteger(idle) && idle >= 0) env.push(`GIX_IDLE_MIN=${idle}`);
    env.push('/usr/local/bin/gix-devjob');
    return `${exe('ssh')} -q ${LOGIN} "${env.join(' ')}"`;
}

function configBlock(netid) {
    const host = checked(cfg().get('loginHost'), /^[A-Za-z0-9.:-]+$/, 'loginHost');
    const nul = IS_WIN ? 'NUL' : '/dev/null';
    return [
        BEGIN,
        `Host ${LOGIN}`,
        `    HostName ${host}`,
        `    User ${netid}`,
        `    IdentityFile "${KEY}"`,
        `    IdentitiesOnly yes`,
        `    StrictHostKeyChecking accept-new`,
        ``,
        `Host ${GPU}`,
        `    HostName gix-gpu-job`,
        `    User ${netid}`,
        `    IdentityFile "${KEY}"`,
        `    IdentitiesOnly yes`,
        `    ProxyCommand ${proxyCommand()}`,
        `    # Slurm can put you on any GPU node, each with its own host key`,
        `    StrictHostKeyChecking no`,
        `    UserKnownHostsFile ${nul}`,
        `    LogLevel ERROR`,
        `    ServerAliveInterval 30`,
        END,
        '',
    ].join('\n');
}

function writeSshConfig(netid) {
    fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
    let old = fs.existsSync(SSH_CONFIG) ? fs.readFileSync(SSH_CONFIG, 'utf8') : '';
    if (old && !fs.existsSync(SSH_CONFIG + '.gix-backup')) {
        fs.copyFileSync(SSH_CONFIG, SSH_CONFIG + '.gix-backup');
    }
    const start = old.indexOf(BEGIN);
    const stop = old.indexOf(END);
    if (start !== -1 && stop > start) {
        old = old.slice(0, start) + old.slice(stop + END.length).replace(/^(\r?\n)+/, '');
    }
    // ssh uses the first match, so our block goes on top
    fs.writeFileSync(SSH_CONFIG, configBlock(netid) + '\n' + old, { mode: 0o600 });
}

// ---------- VS Code settings Remote-SSH needs ----------

async function tuneRemoteSsh() {
    const r = vscode.workspace.getConfiguration('remote.SSH');
    // gix-devjob may wait minutes for a free GPU; the default is 15 s
    if ((r.get('connectTimeout') || 0) < 660) {
        await r.update('connectTimeout', 660, vscode.ConfigurationTarget.Global);
    }
    const plat = Object.assign({}, r.get('remotePlatform') || {});
    if (plat[GPU] !== 'linux' || plat[LOGIN] !== 'linux') {
        plat[GPU] = 'linux';
        plat[LOGIN] = 'linux';
        await r.update('remotePlatform', plat, vscode.ConfigurationTarget.Global);
    }
}

// ---------- sign in ----------

function waitForTerminal(term) {
    return new Promise((resolve) => {
        const sub = vscode.window.onDidCloseTerminal((t) => {
            if (t === term) {
                sub.dispose();
                resolve(t.exitStatus ? t.exitStatus.code : undefined);
            }
        });
    });
}

async function signIn() {
    const netid = (await vscode.window.showInputBox({
        title: 'GIX GPU: Sign in',
        prompt: 'Your UW NetID',
        value: cfg().get('netid') || '',
        ignoreFocusOut: true,
        validateInput: (v) => (/^[A-Za-z0-9._-]+$/.test(v.trim()) ? undefined : 'Letters, digits, . _ - only'),
    }))?.trim();
    if (!netid) return;

    await cfg().update('netid', netid, vscode.ConfigurationTarget.Global);

    if (!fs.existsSync(KEY)) {
        fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
        const kg = await run(exe('ssh-keygen'), ['-q', '-t', 'ed25519', '-N', '', '-C', `gix-${netid}`, '-f', KEY]);
        if (kg.code !== 0) {
            vscode.window.showErrorMessage(`GIX GPU: ssh-keygen failed: ${kg.stderr || kg.stdout}`);
            return;
        }
    }
    writeSshConfig(netid);
    await tuneRemoteSsh();

    let ok = (await sshBatch(LOGIN, 'true')).code === 0;
    if (!ok) {
        const pub = fs.readFileSync(KEY + '.pub', 'utf8').trim();
        if (!/^ssh-ed25519 [A-Za-z0-9+/=]+( [^'"\\]*)?$/.test(pub)) {
            vscode.window.showErrorMessage(`GIX GPU: unexpected public key format in ${KEY}.pub`);
            return;
        }
        const remote = `umask 077; mkdir -p ~/.ssh; grep -qxF '${pub}' ~/.ssh/authorized_keys 2>/dev/null || echo '${pub}' >> ~/.ssh/authorized_keys; echo GIX: key installed`;
        vscode.window.showInformationMessage('GIX GPU: type your NetID password in the terminal below (only this once).');
        const term = vscode.window.createTerminal({
            name: 'GIX sign-in',
            shellPath: exe('ssh'),
            shellArgs: ['-o', 'PubkeyAuthentication=no', LOGIN, remote],
        });
        term.show();
        // finish as soon as key login works, even if the terminal stays open
        let done = false;
        const keyWorks = new Promise((resolve) => {
            const tick = async () => {
                if (done) return;
                if ((await sshBatch(LOGIN, 'true')).code === 0) return resolve('key');
                setTimeout(tick, 3000);
            };
            setTimeout(tick, 3000);
        });
        const first = await Promise.race([keyWorks, waitForTerminal(term).then(() => 'closed')]);
        done = true;
        if (first === 'key') term.dispose();
        ok = (await sshBatch(LOGIN, 'true')).code === 0;
    }
    if (!ok) {
        vscode.window.showErrorMessage('GIX GPU: could not log in to the cluster. Are you on UW IoT, and is the NetID/password right?');
        return;
    }

    const home = (await sshBatch(LOGIN, 'getent passwd "$USER" | cut -d: -f6')).stdout.trim();
    if (home.startsWith('/')) await ctx.globalState.update('home', home);

    await vscode.commands.executeCommand('setContext', 'gix.signedIn', true);
    refresh();
    const pick = await vscode.window.showInformationMessage(`GIX GPU: signed in as ${netid}.`, 'Start GPU workspace');
    if (pick) start();
}

function signedIn() {
    return Boolean(cfg().get('netid')) && fs.existsSync(KEY);
}

// ---------- open ----------

function shQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function remoteHome() {
    let home = ctx.globalState.get('home');
    if (!home) {
        home = (await sshBatch(LOGIN, 'getent passwd "$USER" | cut -d: -f6')).stdout.trim();
        if (home.startsWith('/')) await ctx.globalState.update('home', home);
    }
    return home && home.startsWith('/') ? home : undefined;
}

// Recent projects live on the laptop: [{ path, repo?, node?, ts }]
function recents() {
    return ctx.globalState.get('recents') || [];
}

async function remember(entry) {
    const list = recents().filter((r) => r.path !== entry.path);
    list.unshift({ ...entry, ts: Date.now() });
    await ctx.globalState.update('recents', list.slice(0, 10));
    panel.refresh();
}

async function forget(p) {
    await ctx.globalState.update('recents', recents().filter((r) => r.path !== p));
    panel.refresh();
}

function repoName(url) {
    return url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() || 'project';
}

// Start GPU workspace: pick a recent project, a folder, or a git repo to clone.
async function start() {
    if (!signedIn()) return signIn();
    const home = await remoteHome();
    if (!home) {
        vscode.window.showErrorMessage('GIX GPU: cannot reach gix-login. Are you on UW IoT?');
        return;
    }
    const tilde = (p) => (p.startsWith(home) ? '~' + p.slice(home.length) : p);
    const items = recents().map((r) => ({
        label: `$(folder) ${path.posix.basename(r.path) || r.path}`,
        description: tilde(r.path),
        detail: [r.repo ? `git: ${r.repo}` : '', r.node ? `last on ${r.node}` : ''].filter(Boolean).join(' · ') || undefined,
        entry: r,
        buttons: [{ iconPath: new vscode.ThemeIcon('close'), tooltip: 'Remove from list' }],
    }));
    if (items.length) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push(
        { label: '$(repo-clone) Clone a git repository...', action: 'clone' },
        { label: '$(folder-opened) Open a folder on the cluster...', action: 'folder' },
        { label: '$(home) Just my home folder', action: 'home' }
    );

    const qp = vscode.window.createQuickPick();
    qp.title = 'GIX GPU: Start GPU workspace';
    qp.placeholder = 'Pick a project. A folder with .devcontainer/ can then be reopened in a container.';
    qp.items = items;
    const picked = await new Promise((resolve) => {
        qp.onDidAccept(() => { resolve(qp.selectedItems[0]); qp.hide(); });
        qp.onDidHide(() => resolve(undefined));
        qp.onDidTriggerItemButton(async (e) => {
            await forget(e.item.entry.path);
            qp.items = qp.items.filter((i) => i !== e.item);
        });
        qp.show();
    });
    qp.dispose();
    if (!picked) return;

    if (picked.entry) return openProject(picked.entry);
    if (picked.action === 'home') return openProject({ path: home });
    if (picked.action === 'folder') {
        const v = await vscode.window.showInputBox({
            title: 'Folder on the GPU node',
            prompt: 'Created if it does not exist. Node home folders are local to each node.',
            value: '~/',
            ignoreFocusOut: true,
        });
        if (!v) return;
        const p = v.trim().replace(/^~(?=\/|$)/, home);
        if (!p.startsWith('/')) {
            vscode.window.showErrorMessage('GIX GPU: use a path starting with / or ~/');
            return;
        }
        return openProject({ path: path.posix.normalize(p) });
    }
    if (picked.action === 'clone') {
        const url = (await vscode.window.showInputBox({
            title: 'Clone a git repository',
            prompt: 'https://... or git@... (for private repos, set up a token or key on the cluster first)',
            ignoreFocusOut: true,
        }))?.trim();
        if (!url) return;
        if (!/^(https:\/\/|git@|ssh:\/\/)[^\s'"]+$/.test(url)) {
            vscode.window.showErrorMessage('GIX GPU: that does not look like a git URL.');
            return;
        }
        return openProject({ path: path.posix.join(home, repoName(url)), repo: url });
    }
}

// Get the GPU (preferring the node this project was on), make sure the folder exists, open it.
async function openProject(entry) {
    if (!signedIn()) return signIn();
    const folder = entry.path;
    const prep = entry.repo
        ? `if [ -d ${shQuote(folder)} ]; then echo GIX_EXISTED; else git clone --quiet ${shQuote(entry.repo)} ${shQuote(folder)} && echo GIX_CREATED; fi`
        : `if [ -d ${shQuote(folder)} ]; then echo GIX_EXISTED; else mkdir -p ${shQuote(folder)} && echo GIX_CREATED; fi`;
    // node homes are local: ask gix-devjob for the node that has this project, if it is free
    const extra = [];
    if (entry.node && /^[A-Za-z0-9.-]+$/.test(entry.node) && !cfg().get('node')) {
        extra.push('-o', `ProxyCommand=${proxyCommand([`GIX_PREFER_NODE=${entry.node}`])}`);
    }
    const name = path.posix.basename(folder) || folder;

    const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'GIX GPU', cancellable: false },
        async (progress) => {
            progress.report({ message: 'asking Slurm for a GPU (can take a few minutes when the lab is busy)...' });
            const poll = setInterval(async () => {
                const s = await jobStatus();
                if (s.kind === 'pending') progress.report({ message: 'all GPUs busy, waiting in the queue...' });
                if (s.kind === 'running') progress.report({ message: `got ${s.node}, preparing ${name}...` });
            }, 8000);
            try {
                return await sshBatch(GPU, prep, 11 * 60 * 1000, extra);
            } finally {
                clearInterval(poll);
            }
        }
    );
    const s = await jobStatus();
    render(s);
    if (res.code !== 0) {
        const msg = (res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ');
        vscode.window.showErrorMessage(`GIX GPU: could not start the workspace. ${msg}`);
        return;
    }
    const node = s.kind === 'running' ? s.node : undefined;
    if (entry.node && node && node !== entry.node && res.stdout.includes('GIX_CREATED')) {
        const how = entry.repo ? 'It was cloned again here; push your work to git to keep it in sync.' : 'This is a new, empty folder.';
        vscode.window.showWarningMessage(
            `GIX GPU: ${entry.node} was busy, so you got ${node}. Your files from before are on ${entry.node}. ${how}`
        );
    }
    await remember({ path: folder, repo: entry.repo, node: node || entry.node });

    const uri = vscode.Uri.parse(`vscode-remote://ssh-remote+${GPU}${folder}`);
    const busy = (vscode.workspace.workspaceFolders || []).length > 0 || vscode.env.remoteName;
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: Boolean(busy) });
}

// ---------- status / release ----------

async function jobStatus() {
    if (!signedIn()) return { kind: 'signedOut' };
    const r = await sshBatch(LOGIN, 'squeue -h -u "$USER" -n "devc-$USER" -o "%T|%N|%L|%i|%b"', 15000);
    if (r.code !== 0) return { kind: 'offline' };
    const line = r.stdout.trim().split('\n')[0];
    if (!line) return { kind: 'none' };
    const [state, node, left, id, gres] = line.split('|');
    if (state === 'RUNNING') return { kind: 'running', node, left, id, gres };
    return { kind: 'pending', state, id };
}

function render(s) {
    lastStatus = s;
    const node = s.node ? s.node.replace(/^gix-/, '') : '';
    const map = {
        signedOut: ['$(account) GIX: sign in', 'Sign in to use the GIX GPU cluster'],
        offline: ['$(debug-disconnect) GIX: offline', 'gix-login not reachable. Connect to UW IoT.'],
        none: ['$(vm) GIX: no GPU', 'No GPU job. Click to start a GPU workspace.'],
        pending: ['$(sync~spin) GIX: waiting for GPU', `Job ${s.id} is queued (${s.state}).`],
        running: [`$(vm-running) GIX: ${node} · ${s.left}`, `Job ${s.id} on ${s.node} (${s.gres || 'gpu'}), ${s.left} left. Click for options.`],
        unknown: ['$(vm) GIX', 'GIX GPU'],
    };
    const [text, tip] = map[s.kind] || map.unknown;
    statusItem.text = text;
    statusItem.tooltip = tip;
    statusItem.show();
    panel.refresh();
}

async function refresh() {
    render(await jobStatus());
}

async function release() {
    const s = await jobStatus();
    if (s.kind !== 'running' && s.kind !== 'pending') {
        vscode.window.showInformationMessage('GIX GPU: you have no GPU job right now.');
        render(s);
        return;
    }
    const yes = await vscode.window.showWarningMessage(
        `Release the GPU on ${s.node || 'the queue'}? Your devcontainer and everything running in it stops.`,
        { modal: true },
        'Release'
    );
    if (yes !== 'Release') return;
    const r = await sshBatch(LOGIN, 'scancel -u "$USER" -n "devc-$USER"');
    if (r.code !== 0) vscode.window.showErrorMessage(`GIX GPU: scancel failed: ${r.stderr}`);
    else vscode.window.showInformationMessage('GIX GPU: GPU released.');
    setTimeout(refresh, 2000);
}

async function menu() {
    const items = [];
    if (!signedIn()) items.push({ label: '$(account) Sign in', cmd: 'gix.signIn' });
    else {
        items.push({ label: '$(play) Start GPU workspace...', cmd: 'gix.start' });
        for (const r of recents().slice(0, 3)) {
            items.push({ label: `$(folder) ${path.posix.basename(r.path) || r.path}`, description: r.node || '', entry: r });
        }
        if (lastStatus.kind === 'running' || lastStatus.kind === 'pending') items.push({ label: '$(debug-stop) Release GPU', cmd: 'gix.release' });
        items.push({ label: '$(refresh) Refresh status', cmd: 'gix.refresh' });
        items.push({ label: '$(account) Sign in again / change NetID', cmd: 'gix.signIn' });
    }
    items.push({ label: '$(gear) Settings (GPU size, RAM, time)', cmd: 'gix.settings' });
    const pick = await vscode.window.showQuickPick(items, { title: 'GIX GPU' });
    if (pick?.entry) openProject(pick.entry);
    else if (pick) vscode.commands.executeCommand(pick.cmd);
}

// ---------- side panel ----------

class Panel {
    constructor() {
        this._emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._emitter.event;
    }
    refresh() {
        this._emitter.fire();
    }
    getTreeItem(e) {
        return e;
    }
    getChildren() {
        if (!signedIn()) return [];
        const item = (label, icon, command, description) => {
            const t = new vscode.TreeItem(label);
            t.iconPath = new vscode.ThemeIcon(icon);
            if (command) t.command = { command, title: label };
            if (description) t.description = description;
            return t;
        };
        const s = lastStatus;
        const statusLine = {
            running: item(`GPU on ${s.node}`, 'vm-running', 'gix.refresh', `${s.left} left`),
            pending: item('Waiting for a free GPU', 'sync~spin', 'gix.refresh'),
            none: item('No GPU in use', 'vm', 'gix.refresh'),
            offline: item('Offline: connect to UW IoT', 'debug-disconnect', 'gix.refresh'),
        }[s.kind] || item('Checking...', 'loading~spin', 'gix.refresh');
        const out = [statusLine, item('Start GPU workspace...', 'play', 'gix.start')];
        for (const r of recents().slice(0, 5)) {
            const t = item(path.posix.basename(r.path) || r.path, 'folder', undefined, r.node || '');
            t.tooltip = `${r.path}${r.repo ? `\n${r.repo}` : ''}`;
            t.command = { command: 'gix.openRecent', title: 'Open', arguments: [r] };
            out.push(t);
        }
        if (s.kind === 'running' || s.kind === 'pending') out.push(item('Release GPU', 'debug-stop', 'gix.release'));
        out.push(item(`Signed in as ${cfg().get('netid')}`, 'account', 'gix.signIn'));
        return out;
    }
}

// ---------- lifecycle ----------

function activate(context) {
    ctx = context;
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusItem.command = 'gix.menu';
    panel = new Panel();

    context.subscriptions.push(
        statusItem,
        vscode.window.registerTreeDataProvider('gix.panel', panel),
        vscode.commands.registerCommand('gix.signIn', signIn),
        vscode.commands.registerCommand('gix.start', start),
        vscode.commands.registerCommand('gix.openRecent', (r) => (r ? openProject(r) : start())),
        vscode.commands.registerCommand('gix.release', release),
        vscode.commands.registerCommand('gix.refresh', refresh),
        vscode.commands.registerCommand('gix.menu', menu),
        vscode.commands.registerCommand('gix.settings', () =>
            vscode.commands.executeCommand('workbench.action.openSettings', '@ext:uw-gix.gix-gpu')),
        vscode.workspace.onDidChangeConfiguration((e) => {
            // keep the ProxyCommand in ~/.ssh/config in sync with the GPU size/time settings
            if (e.affectsConfiguration('gix') && signedIn()) {
                try {
                    writeSshConfig(cfg().get('netid'));
                } catch (err) {
                    vscode.window.showErrorMessage(String(err.message || err));
                }
                refresh();
            }
        }),
        { dispose: () => clearInterval(pollTimer) }
    );

    vscode.commands.executeCommand('setContext', 'gix.signedIn', signedIn());
    render(signedIn() ? { kind: 'unknown' } : { kind: 'signedOut' });
    if (signedIn()) refresh();
    pollTimer = setInterval(() => signedIn() && refresh(), 60000);
}

function deactivate() {}

module.exports = { activate, deactivate };
