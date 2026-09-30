#!/usr/bin/env python3
"""Optional real CPU/Gloo adapter smoke. No GPUs, SSH or scheduler dispatch."""
from contextlib import nullcontext
from datetime import timedelta
import json
import multiprocessing
import os
from pathlib import Path
import random
import sys
import tempfile
import time

os.environ.update(CUDA_VISIBLE_DEVICES='',OMP_NUM_THREADS='1',MKL_NUM_THREADS='1',GLOO_SOCKET_IFNAME='lo')
import numpy as np
import torch
import torch.distributed as dist
from torch.nn.parallel import DistributedDataParallel

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'gpuq'))
from gpuq.checkpoint import checkpoint_at_epoch_end,resume_checkpoint_path,CheckpointPeerError
from gpuq.constants import SCHEMA_VERSION,CHECKPOINT_EXIT_CODE
from gpuq.elastic import compatible_world_sizes,plan_elastic_batch
from gpuq.util import atomic_write_json

GLOBAL_BATCH,MICRO_BATCH,LR,EPOCHS,BOUNDARY=12,2,0.025,4,2


def components():
    torch.manual_seed(1234)
    model=torch.nn.Linear(5,1,dtype=torch.float64)
    optimizer=torch.optim.SGD(model.parameters(),lr=LR,momentum=0.9,weight_decay=0.01)
    scheduler=torch.optim.lr_scheduler.StepLR(optimizer,step_size=1,gamma=1.0)
    return model,optimizer,scheduler


def batch(epoch):
    generator=torch.Generator().manual_seed(700+epoch)
    return torch.randn(GLOBAL_BATCH,5,generator=generator,dtype=torch.float64),torch.randn(GLOBAL_BATCH,1,generator=generator,dtype=torch.float64)


def rng():return {'python':random.getstate(),'numpy':np.random.get_state(),'torch':torch.get_rng_state()}


def restore_rng(saved):
    random.setstate(saved['python']);np.random.set_state(saved['numpy']);torch.set_rng_state(saved['torch'])
    assert random.getstate()==saved['python'];np.testing.assert_equal(np.random.get_state(),saved['numpy']);assert torch.equal(torch.get_rng_state(),saved['torch'])


def random_values():return random.random(),float(np.random.random()),float(torch.rand(()))


def broadcast(decision):
    values=[decision];dist.broadcast_object_list(values,src=0);return values[0]


def worker(rank,size,folder,stage,resume=None):
    folder=Path(folder);control=folder/'control';result=folder/('rank-'+str(rank)+'.json');initialized=False
    try:
        torch.set_num_threads(1);torch.set_num_interop_threads(1);assert not torch.cuda.is_initialized()
        dist.init_process_group('gloo',init_method=(folder/'rendezvous').as_uri(),rank=rank,world_size=size,timeout=timedelta(seconds=25));initialized=True
        model,optimizer,scheduler=components();random.seed(2000+rank);np.random.seed(2000+rank);torch.manual_seed(2000+rank)
        plan=plan_elastic_batch(environ={'WORLD_SIZE':str(size),'GPUQ_ASSIGNED_GPU_COUNT':str(size),'GPUQ_TARGET_GLOBAL_BATCH_SIZE':str(GLOBAL_BATCH),'GPUQ_PER_DEVICE_MICRO_BATCH_SIZE':str(MICRO_BATCH)})
        assert plan.exact and plan.effective_global_batch_size==GLOBAL_BATCH and plan.scale_learning_rate(LR)==LR
        start,restored,new_rank=0,False,False
        if resume:
            os.environ['GPUQ_RESUME_CHECKPOINT']=resume
            saved=torch.load(resume_checkpoint_path(),map_location='cpu',weights_only=False)
            model.load_state_dict(saved['model']);optimizer.load_state_dict(saved['optimizer']);scheduler.load_state_dict(saved['scheduler']);start=saved['epoch']
            assert start==BOUNDARY and scheduler.last_epoch==BOUNDARY and optimizer.param_groups[0]['lr']==LR
            if rank<len(saved['rng_by_rank']):
                state=saved['rng_by_rank'][rank];restore_rng(state);expected=random_values();restore_rng(state);assert random_values()==expected;restore_rng(state);restored=True
            else:new_rank=True  # A newly added rank has no prior per-rank RNG.
        wrapped=DistributedDataParallel(model)
        for epoch in range(start,EPOCHS):
            optimizer.zero_grad(set_to_none=True);features,targets=batch(epoch)
            for micro in range(plan.gradient_accumulation_steps):
                offset=(micro*size+rank)*MICRO_BATCH
                context=wrapped.no_sync() if micro+1<plan.gradient_accumulation_steps else nullcontext()
                with context:
                    loss=torch.nn.functional.mse_loss(wrapped(features[offset:offset+MICRO_BATCH]),targets[offset:offset+MICRO_BATCH])
                    (loss/plan.gradient_accumulation_steps).backward()
            optimizer.step();scheduler.step();assert optimizer.param_groups[0]['lr']==LR;random_values()
            if stage!='resume' and epoch+1==BOUNDARY:
                rng_by_rank=[None]*size;dist.all_gather_object(rng_by_rank,rng())
                if rank==0:atomic_write_json(control/'request.json',{'version':SCHEMA_VERSION,'nonce':'cpu-'+stage,'attempt_id':'A'+str(size),'requested_by_job_id':'Jcpu-smoke','created_at':time.time(),'expires_at':time.time()+60},mode=0o600)
                dist.barrier()
                def save():
                    if stage=='fail-save':raise RuntimeError('synthetic checkpoint save failure')
                    destination=folder/'checkpoint.pt';temporary=folder/'checkpoint.tmp'
                    with temporary.open('wb') as stream:
                        torch.save({'model':model.state_dict(),'optimizer':optimizer.state_dict(),'scheduler':scheduler.state_dict(),'rng_by_rank':rng_by_rank,'epoch':epoch+1,'world_size':size,'global_batch':GLOBAL_BATCH,'lr':LR},stream)
                        stream.flush();os.fsync(stream.fileno())
                    os.replace(temporary,destination)
                    return {'checkpoint_path':str(destination),'resume_epoch':epoch+1}
                try:checkpoint_at_epoch_end(save,rank=rank,barrier=dist.barrier,broadcast_decision=broadcast,control_dir=control)
                except SystemExit as stopped:
                    atomic_write_json(result,{'status':'checkpointed','exit_code':stopped.code,'epoch':epoch+1,'accumulation':plan.gradient_accumulation_steps,'lr':optimizer.param_groups[0]['lr']});raise
                except (RuntimeError,CheckpointPeerError) as error:
                    if stage!='fail-save':raise
                    atomic_write_json(result,{'status':'save-failed','error_type':type(error).__name__,'epoch':epoch+1});raise SystemExit(1)
                raise AssertionError('checkpoint request did not stop/fail collectively')
            elif stage!='resume':assert checkpoint_at_epoch_end(lambda:None,rank=rank,barrier=dist.barrier,broadcast_decision=broadcast,control_dir=control) is False
        assert not torch.cuda.is_initialized()
        torch.save({'model':model.state_dict(),'optimizer':optimizer.state_dict(),'scheduler':scheduler.state_dict()},folder/('final-'+str(rank)+'.pt'))
        atomic_write_json(result,{'status':'complete','epoch':EPOCHS,'start_epoch':start,'accumulation':plan.gradient_accumulation_steps,'global_batch':plan.effective_global_batch_size,'lr':optimizer.param_groups[0]['lr'],'restored_rng':restored,'new_rank_rng':new_rank})
    finally:
        if initialized:dist.destroy_process_group()


def launch(root,name,size,resume=None,fail_save=False):
    folder=root/name;folder.mkdir();(folder/'control').mkdir();context=multiprocessing.get_context('spawn');stage='resume' if resume else 'fail-save' if fail_save else 'preempt'
    children=[context.Process(target=worker,args=(rank,size,str(folder),stage,resume)) for rank in range(size)]
    for child in children:child.start()
    try:
        deadline=time.monotonic()+70
        for child in children:child.join(max(0,deadline-time.monotonic()))
        assert not any(child.is_alive() for child in children),'CPU/Gloo stage timed out'
        expected=0 if resume else 1 if fail_save else CHECKPOINT_EXIT_CODE
        assert [child.exitcode for child in children]==[expected]*size,[(child.pid,child.exitcode) for child in children]
        states=[json.loads((folder/('rank-'+str(rank)+'.json')).read_text()) for rank in range(size)]
        assert all(s['status']==('complete' if resume else 'save-failed' if fail_save else 'checkpointed') for s in states)
        return folder,states
    finally:
        for child in children:
            if child.is_alive():child.terminate();child.join(5)


def reference():
    model,optimizer,scheduler=components()
    for epoch in range(EPOCHS):
        features,targets=batch(epoch);optimizer.zero_grad(set_to_none=True);torch.nn.functional.mse_loss(model(features),targets).backward();optimizer.step();scheduler.step()
    return {'model':model.state_dict(),'optimizer':optimizer.state_dict(),'scheduler':scheduler.state_dict()}


def same(actual,expected):
    if isinstance(expected,torch.Tensor):torch.testing.assert_close(actual,expected,rtol=1e-12,atol=1e-12)
    elif isinstance(expected,dict):
        assert set(actual)==set(expected)
        for key,value in expected.items():same(actual[key],value)
    elif isinstance(expected,(tuple,list)):
        assert len(actual)==len(expected)
        for first,second in zip(actual,expected):same(first,second)
    else:assert actual==expected,(actual,expected)


def main():
    torch.set_num_threads(1);assert compatible_world_sizes(GLOBAL_BATCH,MICRO_BATCH,1,4)==(1,2,3)
    try:plan_elastic_batch(GLOBAL_BATCH,MICRO_BATCH,world_size=4,environ={})
    except ValueError:pass
    else:raise AssertionError('incompatible world size silently rounded accumulation')
    expected=reference();results=[]
    with tempfile.TemporaryDirectory(prefix='gpuq-cpu-ddp-') as temporary:
        root=Path(temporary)
        for initial in (1,2):
            prior,stopped=launch(root,'preempt-'+str(initial),initial);ack=json.loads((prior/'control/ack.json').read_text())
            assert ack['exit_code']==CHECKPOINT_EXIT_CODE and ack['resume_epoch']==BOUNDARY;checkpoint=Path(ack['checkpoint_path']);assert checkpoint.is_file()
            resumed,states=launch(root,'resume-'+str(initial)+'-to-3',3,resume=str(checkpoint))
            for rank,state in enumerate(states):
                assert state['start_epoch']==BOUNDARY and state['lr']==LR and state['global_batch']==GLOBAL_BATCH
                assert state['restored_rng']==(rank<initial) and state['new_rank_rng']==(rank>=initial)
                same(torch.load(resumed/('final-'+str(rank)+'.pt'),map_location='cpu',weights_only=False),expected)
            results.append({'resize':str(initial)+'->3','initial_accumulation':stopped[0]['accumulation'],'resumed_accumulation':states[0]['accumulation'],'checkpoint_exit_codes':[s['exit_code'] for s in stopped],'model_optimizer_scheduler_match':True,'global_batch':GLOBAL_BATCH,'lr':LR})
        failed,states=launch(root,'fail-save',3,fail_save=True)
        assert not (failed/'control/ack.json').exists() and not (failed/'checkpoint.pt').exists() and not list(failed.glob('final-*.pt'))
        assert all(s['epoch']==BOUNDARY for s in states);assert states[0]['error_type']=='RuntimeError' and all(s['error_type']=='CheckpointPeerError' for s in states[1:])
    print(json.dumps({'status':'passed','backend':'CPU/Gloo','torch':torch.__version__,'cases':results,'failed_save_consensus':'all ranks fail; no ACK or resumed result','bounds':'deterministic FP64 linear model; no stochastic augmentation or CUDA/NCCL claim'},ensure_ascii=False))


if __name__=='__main__':main()
