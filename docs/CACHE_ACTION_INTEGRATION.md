# 手动缓存中央文件集成清单

中央集成已在源码中接入；本页列出完整依赖与验收边界，供后续发布核对。源码集成不代表生产已实施，仍需完成测试并分阶段配套发布。

## Portal

1. `portal-service.mjs` 导入 `installDatasetCacheActions`（`./dataset-cache-actions.mjs`），在已有 dataset replication/storage archive 初始化之后调用 `installDatasetCacheActions(this)`。
2. `invoke(token,operation,args)` 的公共路由仅接受以下五个缓存 literal，并纳入既有四个并发的 `datasetRead` 准入；不进入长时间全局 mutation queue：

```js
['datasets.cache.capabilities', 'datasets.cache.prepare',
 'datasets.cache.release', 'datasets.cache.status', 'datasets.cache.cancel']
```

`datasetRead` 在准入和返回时重新核实会话/权限，在操作之前检查维护状态，并将原 check 回调交给 `datasetCacheActionsCall`。模块内部最多四个缓存 mutation 在途，同 key 合并；所有桥等待结束后再次鉴权。它不需要新的 execution.mjs 泛化透传，也不把整段 `datasets.cache.*` 转发节点。

3. `deploy/Dockerfile` 最终 stage 把 `dataset-cache-actions.mjs` 加入现有数据模块 COPY。
4. `maintenance.mjs`：公共 `datasets.cache.capabilities/status/cancel` 及对应私有 `storage.cache-action.capabilities/status/cancel` 使用已有数据只读/取消维护准入；两侧新 prepare/release 仍拒绝。不要让取消依赖门户主页完整刷新。准备 worker 被多位成员或训练共用，`prepareCancel:false`；只有独立 release worker 可以明确取消。

## 节点私有桥

`deploy/execution-worker.py` 的 INTERNAL_STORAGE 只添加以下五个 literal：

```python
INTERNAL_STORAGE += tuple('storage.cache-action.' + action for action in
                          ('capabilities', 'prepare', 'release', 'status', 'cancel'))
```

不加入 LAN peer、upload ticket、公开 forced-command 字节接口或任意执行 API。

## 节点 executor

在 `deploy/node-executor.py` 添加懒加载适配器，不改其他 dataset worker 的请求形状：

```python
DATASET_CACHE_ACTIONS = None

def dataset_cache_actions():
    global DATASET_CACHE_ACTIONS
    if DATASET_CACHE_ACTIONS is None:
        spec=importlib.util.spec_from_file_location('gpuq_dataset_cache_actions', HERE/'dataset-cache-actions.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        DATASET_CACHE_ACTIONS=module.from_executor(sys.modules[__name__] if __name__ in sys.modules else SimpleNamespace(**globals()))
    return DATASET_CACHE_ACTIONS

def dataset_cache_action_operation(operation,args):
    allowed=('capabilities','prepare','release','status','cancel')
    action=operation.removeprefix('storage.cache-action.')
    if action not in allowed or not isinstance(args,dict) or args.get('hostAdmin') is not False:
        raise ValueError('Invalid authenticated cache action')
    module,_=dataset_cache();actor=dataset_actor(module,args)
    request={key:value for key,value in args.items() if key not in ('userId','hostAdmin')}
    return dataset_cache_actions().dispatch(actor,action,request)
```

在 `process` 内、普通 dataset 路由之前增加 literal namespace 分支：

```python
if operation.startswith('storage.cache-action.'):
    return dataset_cache_action_operation(operation,args)
```

在 `__main__` 的其他 worker flags 旁增加：

```python
if len(sys.argv)==3 and sys.argv[1]=='--dataset-cache-worker':
    sys.exit(dataset_cache_actions().release_worker(sys.argv[2]))
```

最后 `deploy/node-runtime.json` dependencies 增加 `dataset-cache-actions.py`。不得只发布新私有 namespace 而漏 helper/flag/runtime清单；capabilities 只有适配器完整构造后返回 protocol 1。

## 发布

先发布依赖/helper，再 executor activation；确认挂载、authority grant 和 helper 指纹匹配，最后 Portal route/image。已有冻结迁移清单/pinned helper SHA 需按项目正式发布协议处理，不在此绕过。新功能不解除现有维护、不启用训练/自动 GC、不重启任何训练 unit。
