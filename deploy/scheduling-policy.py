"""Explicit queue rank and voluntary yielding; no legacy-victim takeover."""
import importlib.util

PRIORITY_PRESETS = {'idle': (0, 'now'), 'normal': (2, 'never'), 'high': (4, 'never')}


def ready(config, here):
    try:
        spec=importlib.util.spec_from_file_location('gpuq_training_control',here/'training-control.py')
        control=importlib.util.module_from_spec(spec);spec.loader.exec_module(control)
        return control.ready(config,here)
    except (OSError, ImportError, AttributeError, SyntaxError, TypeError):
        return False


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
