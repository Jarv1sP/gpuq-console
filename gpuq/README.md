# GPUQ

此目录是既有实验室 GPUQ 的完整 Python 源码，门户通过节点桥调用它，不重新实现一套与老用户竞争的队列。核心依赖 Python 标准库、Linux systemd/cgroup v2、NVIDIA 驱动与 `nvidia-smi`。

## 构建与首次安装

```sh
python3 scripts/build-gpuq.py
python3 build/gpuq.pyz --help
```

在仓库根目录运行。产物是 `build/gpuq.pyz`；固定文件时间、仅包含 `.py`，不打包数据库、配置、缓存或凭据。新机器使用 [部署手册](../docs/DEPLOYMENT.md) 的节点安装流程，生成 GPU UUID 清单、独立目录和用户 systemd 服务。已有 GPUQ 的数据库和运行状态应保留，**不要为了装门户重新初始化调度器**。

## 老用户的短命令

```sh
gpu status
gpu health
gpu submit -g 1 -- python train.py
gpu submit -g 2 -- python -m torch.distributed.run --standalone --nproc-per-node=2 train.py
gpu show J任务号
gpu logs J任务号
gpu cancel J任务号
gpu watch J任务号
gpu submit --help
```

以实际返回的任务 ID 为准；命令细节见 `--help`。`--json` 放在子命令之前。观察模式 `gpu set-mode --observe-only` 不启动新作业；验收后 `gpu set-mode --active` 允许调度。该模式保存在 GPUQ 状态库中；数据库必须备份。

**新平台普通用户使用 `gpuctl`，不直接获得共享服务账号下的 `gpu`。** 直接 GPUQ CLI 是可信旧用户/管理员的接口，不经过门户逐人权限验证；公开给普通用户会绕过门户额度。

## 源码包含的高级能力

单机整卡/固定卡、优先级与排队、保守空闲判定、取消与重试、检查点/抢占协议、弹性扩卡协调、共享/HAMi 适配、fleet/cluster、手工同步、团队消息板、可选 Telegram 通知。

这些模块保留是为了兼容与后续开发，不等于门户已对外开放并审计全部功能。检查点/弹性需要训练程序配合；HAMi 需要另装上游运行库；跨机需要管理员单独定义 fleet 与互信。Telegram 需要自己的私有配置，不会自动读取任何现成凭据。先读相应模块与 CLI help，在测试节点验证后再用。

### 高级 fleet / sync 的独立配置

此配置只供可信管理员使用，**不是门户 `inventory.json` 的 `nodes` 清单**，两者不会自动互相生成。每个 `hosts` 条目必须显式给出目标机器上的 `binary` 与 `config` 绝对路径，不再猜测服务用户的主目录。不能用 `~` 代替绝对路径。

例如将自己的 fleet 清单保存为 `~/.config/gpuq/fleet.json`：

```json
{
  "hosts": {
    "gpu-1": {
      "ssh": "gpuops@100.64.10.11",
      "binary": "/home/gpuops/bin/gpu",
      "config": "/srv/gpuq/config.json"
    },
    "gpu-2": {
      "ssh": "gpuops@100.64.10.12",
      "binary": "/home/gpuops/bin/gpu",
      "config": "/srv/gpuq/config.json"
    }
  }
}
```

以上地址、用户和目录都是示例；按各节点实际安装位置填写，并事先确认 SSH 主机指纹与管理员自己的密钥权限。配置正确后，先做只读核验：

```sh
gpu --fleet-config "$HOME/.config/gpuq/fleet.json" --host gpu-1 status
```

`sync` 同样使用这份 fleet 清单并读取显式路径。旧清单已明确填写有效的 `binary` / `config` 时无需改动；旧版本依赖隐式默认值的清单，在升级高级工具前补齐即可。此变化不迁移或重启已部署的 GPUQ，也不影响门户普通用户的 `gpuctl` 工作流。

原始代码中的历史默认目录是 `/data1/gpu-scheduler`；新部署安装器通过显式 `--config` 使用 `inventory.json` 的路径，不要求有名为 `/data1` 的硬盘。训练框架不打包进 GPUQ。

上游依赖、许可与来源见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
