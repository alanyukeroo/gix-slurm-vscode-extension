# GIX GPU

Open any project with a `.devcontainer/` on a GIX RTX 5090 from VS Code: course repos, research
code, your own experiments. You need to be on **UW IoT**.

1. Click the **GIX GPU** icon in the left bar -> **Sign in with NetID**. Type your NetID, then
   your NetID password once in the terminal that opens.
2. **Start GPU workspace** -> pick a recent project, **Clone a git repository**, or **Open a folder**.
   The first time, it waits until Slurm gives you a GPU.
3. If the folder has a `.devcontainer/`, VS Code offers **Reopen in Container** -> click it.
4. Done? Just close VS Code. The GPU is released after 30 idle minutes, or right away with
   **Release GPU** (status bar -> GIX).

Projects live in your home folder on the GPU node. Each node has its own disk, so the extension
asks for the node your project was on last time; if that one is busy you get another node and a
notice. Keep your work in git so you can continue anywhere.

Settings (gear icon in the GIX panel): quarter or whole GPU, CPUs, RAM, time limit, idle release.

Devcontainer rules on the cluster: use `--device=nvidia.com/gpu=all` (not `--gpus`), add
`--userns=keep-id:uid=1000,gid=1000` and `"updateRemoteUserUID": false`; no `--privileged`,
`/dev` mounts or `docker.sock`; Docker Compose devcontainers are not supported.

## Install

Download `dist/gix-gpu-<version>.vsix`, then in VS Code: `Cmd/Ctrl+Shift+P` ->
**Extensions: Install from VSIX...**. Remote - SSH and Dev Containers are installed with it.

## Build

No npm needed: `python3 build-vsix.py` packs `gix-gpu-<version>.vsix` from this folder.

## How it works

The extension only drives plain OpenSSH and VS Code's Remote-SSH / Dev Containers. On the cluster,
`gix-devjob` (the SSH ProxyCommand on the login host) gets or reuses a Slurm job and connects to the
node Slurm picked; `pam_slurm_adopt` puts the SSH session, VS Code server and rootless Podman
containers inside that job, so its GPU/CPU/RAM limits apply.
