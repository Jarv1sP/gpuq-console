"""Explicit queue rank and voluntary yielding; no legacy-victim takeover."""
import importlib.util
import re

PRIORITY_PRESETS = {'idle': (0, 'now'), 'normal': (2, 'never'), 'high': (4, 'never')}


def ready(config, here):
    try:
        spec=importlib.util.spec_from_file_location('gpuq_training_control',here/'training-control.py')
        control=importlib.util.module_from_spec(spec);spec.loader.exec_module(control)
        return control.ready(config,here)
    except (OSError, ImportError, AttributeError, SyntaxError, TypeError):
        return False


def allocation_ready(config,here):
    if not ready(config,here):return False
    import ast
    try:
        tree=ast.parse((here/'sandbox-runner.py').read_text())
        return any(isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='GPU_ALLOCATION_PROTOCOL' for t in node.targets) and isinstance(node.value,ast.Constant) and type(node.value.value) is int and node.value.value==1 for node in tree.body)
    except (OSError,SyntaxError):return False


def validate(value):
    fields = {'rank','yieldPolicy','restartPolicy','checkpointable'}
    if not isinstance(value,dict) or set(value)!=fields:
        raise ValueError('Invalid explicit scheduling contract')
    if value['rank'] not in ('P0','P1','P2','P3','P4') or value['yieldPolicy'] not in ('never','now','save') or value['restartPolicy'] not in ('never','on-preempt') or type(value['checkpointable']) is not bool:
        raise ValueError('Invalid explicit scheduling values')
    if value['yieldPolicy']=='save' and not value['checkpointable']:
        raise ValueError('Save yielding requires a checkpoint adapter')
    if value['restartPolicy']=='on-preempt' and (value['yieldPolicy']!='save' or not value['checkpointable']):
        raise ValueError('Automatic resume requires save yielding')
    return value


def normalize_job_policy(job):
    policy = {'kind': 'legacy', 'priority': 0, 'dispatch_mode': 'queue',
              'yield_policy': 'never', 'restart_policy': 'never',
              'checkpointable': False, 'preempt_idle_only': False}
    if 'scheduling' in job:
        if 'priority' in job or 'preemptIdleOnly' in job:
            raise ValueError('Cannot mix scheduling contracts')
        value = validate(job['scheduling'])
        policy.update(kind='explicit', priority=int(value['rank'][1]),
                      yield_policy=value['yieldPolicy'], restart_policy=value['restartPolicy'],
                      checkpointable=value['checkpointable'])
    elif 'priority' in job or 'preemptIdleOnly' in job:
        name = job.get('priority')
        if not isinstance(name, str) or name not in PRIORITY_PRESETS or job.get('preemptIdleOnly') is not True:
            raise ValueError('Explicit safe scheduling policy required')
        rank, yielding = PRIORITY_PRESETS[name]
        policy.update(kind='preset', priority=rank, yield_policy=yielding, preempt_idle_only=True)
    return policy


def submit_arguments(policy):
    # queue already preempts strictly lower-ranked explicit now/save volunteers.
    # It never interprets legacy jobs as having opted into interruption.
    result = ['-p', 'P'+str(policy['priority']), '-m', policy['dispatch_mode'],
              '--yield', policy['yield_policy'], '--restart-policy', policy['restart_policy']]
    if policy['preempt_idle_only']:
        result.append('--preempt-idle-only')
    if policy['checkpointable']:
        result.append('--checkpointable')
    return result


def elastic_allocation(job):
    value=job.get('elastic')
    if 'elastic' not in job:return None
    if not isinstance(value,dict) or set(value)!={'minCards','globalBatch','microBatch','autoExpand'}:
        raise ValueError('Invalid elastic allocation contract')
    cards=job['cards'];minimum=value['minCards'];target=value['globalBatch'];micro=value['microBatch']
    if type(cards) is not int or not 1<=cards<=64 or type(minimum) is not int or not 1<=minimum<=cards or any(type(n) is not int or not 1<=n<=2**53-1 for n in (target,micro)) or type(value['autoExpand']) is not bool:
        raise ValueError('Invalid elastic allocation values')
    allowed=[n for n in range(minimum,cards+1) if target%(n*micro)==0]
    if not allowed:raise ValueError('No exact-batch-compatible card count')
    policy=normalize_job_policy(job)
    if value['autoExpand'] and (not policy['checkpointable'] or policy['restart_policy']!='on-preempt' or len(allowed)<2):
        raise ValueError('Automatic expansion requires checkpoint/resume and multiple legal counts')
    return allowed


def allocation_arguments(job):
    result=['-g',str(job['cards'])]
    if elastic_allocation(job) is not None:
        value=job['elastic']
        result+=['--elastic-start','--min-gpus',str(value['minCards']),'--global-batch',str(value['globalBatch']),'--micro-batch',str(value['microBatch'])]
        if value['autoExpand']:result.append('--auto-expand')
    return result


def allocated_spec(job,indices,uuids):
    """A runtime copy only: stored cards remains the maximum quota reservation."""
    allowed=elastic_allocation(job) or [job['cards']]
    if len(indices) not in allowed or len(uuids)!=len(indices) or len(set(indices))!=len(indices) or len(set(uuids))!=len(uuids) or any(not re.fullmatch('[0-9]+',i) for i in indices) or any(not u.startswith('GPU-') for u in uuids):
        raise ValueError('Missing or incompatible GPUQ allocation')
    return {**job,'cards':len(indices)}
