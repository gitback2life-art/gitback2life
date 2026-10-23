# Adapted copy of the v6 independent review's Python checks (original: D:\CRTS apps\MY_tools\gitback2life_audits\gitback2life_audit_v6\independent_v6_python.py,
# preserved unchanged). Adaptations: ROOT is the working toolbox; the fixture folder is removed in tearDown. Assertions unchanged.
# A REPLACEMENT for the V6-01 test (same attack, signature in the protected folder) is in test_v6_replacements.py.
import sys
sys.dont_write_bytecode=True
from pathlib import Path
import unittest, tempfile, json, subprocess, shutil, struct, zlib, importlib.util
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'_shared'))
import gb2l_core as core
spec=importlib.util.spec_from_file_location('scrub',ROOT/'metadata_scrub'/'metadata_scrub.py')
scrub=importlib.util.module_from_spec(spec);spec.loader.exec_module(scrub)
class Review(unittest.TestCase):
 def setUp(self):
  parent=ROOT/'.test_tmp';parent.mkdir(exist_ok=True)
  self.d=Path(tempfile.mkdtemp(prefix='independent-v6-',dir=parent))
  core.clear_active_scope()
 def tearDown(self):
  core.clear_active_scope();core._reset_authority();shutil.rmtree(self.d,ignore_errors=True)
  try:(ROOT/'.test_tmp').rmdir()
  except OSError:pass
 def test_authority_path_is_file_must_refuse_instead_of_downgrade(self):
  f=self.d/'authority';f.write_text('planted regular file')
  core._set_authority_for_tests(f,check_acl=True)
  with self.assertRaises(core.InputError):core._check_authority(self.d/'scope.json')
 def test_unknown_png_chunk_secret_does_not_survive_scrub_and_write(self):
  secret=b'ghp_SYNTHETICabcdefghijklmnopqrstuvwxyz01'
  def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
  png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',1,1,8,2,0,0,0))+chunk(b'raNd',secret)+chunk(b'IDAT',zlib.compress(b'\0\0\0\0'))+chunk(b'IEND',b'')
  source=self.d/'input.png';source.write_bytes(png)
  scrub.run(source,self.d/'output')
  self.assertNotIn(secret,(self.d/'output'/'input.png').read_bytes())
 def test_scope_verified_must_be_same_scope_python_authorizes(self):
  auth=self.d/'auth';auth.mkdir();node=shutil.which('node')
  for f in ['authority_core.mjs','authority_cli.mjs']:shutil.copyfile(ROOT/'authority'/f,auth/f)
  scope={'incident_id':'synthetic-swap','status':'open','expires_at':'2099-01-01T00:00:00Z','persistence':'local','permissions':{'save_local':False},'question':'q','scope':'s','stopping_condition':'c','targets':['alpha.example'],'urgency':'normal','confidence':'low','prohibited':['p'],'disclosures':[],'approvals':[]}
  js='import {generateAuthorityKey,signAuthorization,recordApproval,emptyState} from '+json.dumps((auth/'authority_core.mjs').as_uri())+';const s='+json.dumps(scope)+';const pass="synthetic testing passphrase";const k=generateAuthorityKey(pass);console.log(JSON.stringify({pub:k.publicKeyPem,signed:signAuthorization(s,{...k,passphrase:pass,serial:1}),state:recordApproval(emptyState(),s.incident_id,1)}));'
  generated=json.loads(subprocess.run([node,'--input-type=module','-e',js],capture_output=True,text=True,check=True).stdout)
  (auth/'public_key.pem').write_text(generated['pub']);(auth/'state.json').write_text(json.dumps(generated['state']))
  p=self.d/'scope.json';Path(str(p)+'.authorization.json').write_text(json.dumps(generated['signed']))
  p.write_text(json.dumps({**scope,'permissions':{'save_local':True}}))
  core._set_authority_for_tests(auth,check_acl=False,node=node)
  original=subprocess.run
  def interleave(args,**kwargs):
   if len(args)>2 and args[2]=='verify':p.write_text(json.dumps(scope))
   return original(args,**kwargs)
  with patch.object(subprocess,'run',side_effect=interleave):
   with self.assertRaises(core.InputError):core.require_scope(p)
if __name__=='__main__':unittest.main(verbosity=2)
