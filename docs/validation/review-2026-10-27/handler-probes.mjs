import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
const root=await fs.mkdtemp(path.join(os.tmpdir(),"p05-spec-review-"));
process.env.REMOTE_AGENT_ALLOWED_ROOTS=root;
process.env.REMOTE_AGENT_DEFAULT_CWD=root;
process.env.P05_STATE_DIR=path.join(root,".p05");
const {registerFsTools}=await import(pathToFileURL(path.join(process.cwd(),"src/tools/register-fs.ts")));
const handlers=new Map();
registerFsTools({expose:(name,config,handler)=>handlers.set(name,handler)}, {currentRoot:()=>root});
try {
  try { await handlers.get("fs_search")({contract_version:2,query:"needle",path:"missing-root"}); }
  catch(error){ console.log(JSON.stringify({probe:"search_missing_root",message:error.message.replaceAll(root,"<fixture>"),leaksResolvedRoot:error.message.includes(root)})); }
  const searchDir=path.join(root,"search");
  await fs.mkdir(searchDir);
  const line="needle"+"中".repeat(234);
  await Promise.all(Array.from({length:100},(_,i)=>fs.writeFile(path.join(searchDir,String(i)+".txt"),(line+"\n").repeat(5))));
  const result=await handlers.get("fs_search")({contract_version:2,query:"needle",path:"search",max_results:100});
  console.log(JSON.stringify({probe:"search",resultBytes:Buffer.byteLength(JSON.stringify(result)),maxAllowed:262144,resultCount:result.structuredContent.results.length,contentText:result.content[0].text,outcome:result.structuredContent.outcome}));
  const patchDir=path.join(root,"patch");
  await fs.mkdir(patchDir);
  const edits=Array.from({length:4},(_,i)=>({old_text:String(i)+"\u0001".repeat(166),new_text:String(i)+"\u0002".repeat(166)}));
  const original=edits.map(x=>x.old_text).join("\n");
  const hash=createHash("sha256").update(original).digest("hex");
  const patches=[];
  for(let i=0;i<20;i++){
    const file="f"+String(i).padStart(2,"0")+"x".repeat(232)+".txt";
    await fs.writeFile(path.join(patchDir,file),original);
    patches.push({path:"patch/"+file,expected_sha256:hash,edits});
  }
  const patch=await handlers.get("apply_patch_many")({contract_version:2,dry_run:true,patches});
  console.log(JSON.stringify({probe:"patch",resultBytes:Buffer.byteLength(JSON.stringify(patch)),defaultAllowed:65536,maxAllowed:262144,status:patch.structuredContent.status,files:patch.structuredContent.files.length,previewChars:patch.structuredContent.files[0].diff?.preview.length}));
} finally {
 const safe=path.resolve(root); const tmp=path.resolve(os.tmpdir());
 if(path.dirname(safe)!==tmp||!path.basename(safe).startsWith("p05-spec-review-")) throw new Error("Unsafe cleanup");
 await fs.rm(safe,{recursive:true,force:true});
}
