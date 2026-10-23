# Adapted copy of the v7 independent review's Python checks (original: gitback2life_audit_v7\independent_v7_python.py,
# preserved unchanged). Adaptations: ROOT is the working toolbox; the fixture folder is removed in tearDown. Assertions unchanged.
import sys
sys.dont_write_bytecode=True
from pathlib import Path
import unittest,importlib.util,json,tempfile,subprocess,struct,zlib,shutil
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'_shared'))
import gb2l_core as core
def module(name):
 spec=importlib.util.spec_from_file_location(name,ROOT/name/(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
org=module('org_registers');access=module('access_offboarding')
class Review(unittest.TestCase):
 def setUp(self):
  p=ROOT/'.test_tmp';p.mkdir(exist_ok=True);self.d=Path(tempfile.mkdtemp(prefix='independent-v7-',dir=p));core.clear_active_scope()
 def tearDown(self):
  core.clear_active_scope();shutil.rmtree(self.d,ignore_errors=True)
  try:(ROOT/'.test_tmp').rmdir()
  except OSError:pass
 def update_without_approval(self,tool,data,record,extra):
  register=self.d/'register.json';register.write_text(json.dumps(data));before=register.read_bytes()
  item=self.d/'record.json';item.write_text(json.dumps(record))
  r=subprocess.run([sys.executable,'-I',str(ROOT/tool/(tool+'.py')),'update',*extra,'--register',str(register),'--record',str(item)],capture_output=True,text=True)
  changed=register.read_bytes()!=before
  print(json.dumps({'tool':tool,'exit':r.returncode,'changed_without_approval':changed,'stdout':r.stdout.strip()}))
  self.assertNotEqual(r.returncode,0,'unapproved CLI update succeeded')
  self.assertFalse(changed)
 def test_org_update_requires_approval(self):
  record=dict(org.TEMPLATES['service']);data={'schema_version':1,'records':[record],'history':[]}
  self.update_without_approval('org_registers',data,{**record,'provider':'Synthetic replacement'},['--kind','service'])
 def test_access_update_requires_approval(self):
  data=json.loads(json.dumps(access.TEMPLATE));record={**data['records'][0],'state':'removed'}
  self.update_without_approval('access_offboarding',data,record,[])
 def test_python_png_transparency_payload_is_not_persisted(self):
  secret=b'ghp_SYNTHETICabcdefghijklmnopqrstuvwxyz01'
  def c(t,d):return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d))
  data=b'\x89PNG\r\n\x1a\n'+c(b'IHDR',struct.pack('>IIBBBBB',1,1,8,2,0,0,0))+c(b'tRNS',secret)+c(b'IDAT',zlib.compress(b'\0\1\2\3'))+c(b'IEND',b'')
  out=self.d/'transparency.png'
  try:core.write_bytes_safely(out,data,binary='image')
  except core.InputError:return
  self.assertNotIn(secret,out.read_bytes())
 def test_python_sensitive_object_is_redacted(self):
  value='SYNTHETIC-CREDENTIAL-VALUE';out=self.d/'report.json'
  core.write(out,{'credentials':{'value':value}})
  self.assertNotIn(value,out.read_text())
if __name__=='__main__':unittest.main(verbosity=2)
