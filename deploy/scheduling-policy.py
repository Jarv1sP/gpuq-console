"""Explicit queue rank and voluntary yielding; no legacy-victim takeover."""
from pathlib import Path


def ready(config, here):
    try:
        return (Path(config['controlRoot']).is_dir() and Path(config['gpuqArchive']).is_file()
                and (here/'training-control.py').is_file()
                and 'gpuq_training_control' in (here/'sandbox-runner.py').read_text())
    except (KeyError, OSError, TypeError):
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


def arguments(value):
    policy = validate(value)
    # queue already preempts strictly lower-ranked explicit now/save volunteers.
    # It never interprets legacy jobs as having opted into interruption.
    return ['-p',policy['rank'],'-m','queue','--yield',policy['yieldPolicy'],
            '--restart-policy',policy['restartPolicy'],*(['--checkpointable'] if policy['checkpointable'] else [])]
