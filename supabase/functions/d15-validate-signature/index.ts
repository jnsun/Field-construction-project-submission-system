import { validateSignatureImage } from "./image-validation.ts";

const headers={"content-type":"application/json","access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type"};
const reply=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers});
async function rpc(url:string,key:string,authorization:string,name:string,body:unknown){
  return fetch(`${url}/rest/v1/rpc/${name}`,{method:"POST",signal:AbortSignal.timeout(10000),headers:{apikey:key,authorization,"content-type":"application/json"},body:JSON.stringify(body)});
}
async function limitedBytes(response:Response){
  if(!response.ok||Number(response.headers.get("content-length")||0)>2097152||!response.body)throw new Error("signature_file_invalid");
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2097152){await reader.cancel();throw new Error("signature_file_invalid");}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}

Deno.serve(async request=>{
  if(request.method==="OPTIONS")return new Response("ok",{headers});
  if(request.method!=="POST")return reply(405,{reason_code:"signature_file_invalid"});
  try{
    const url=Deno.env.get("SUPABASE_URL")||"",anon=Deno.env.get("SUPABASE_ANON_KEY")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
    const authorization=request.headers.get("authorization")||"";
    if(!url||!anon||!service||!authorization.toLowerCase().startsWith("bearer "))return reply(401,{reason_code:"signature_forbidden"});
    const {challenge_id}=await request.json();if(!/^[0-9a-f-]{36}$/i.test(String(challenge_id||"")))throw new Error("signature_file_invalid");
    const contextResponse=await rpc(url,anon,authorization,"training_signature_file_validation_context",{p_challenge_id:challenge_id});
    if(!contextResponse.ok)return reply(contextResponse.status,{reason_code:"signature_forbidden"});
    const context=await contextResponse.json();
    const objectUrl=`${url}/storage/v1/object/authenticated/${encodeURIComponent(context.storage_bucket)}/${String(context.storage_path).split("/").map(encodeURIComponent).join("/")}`;
    const bytes=await limitedBytes(await fetch(objectUrl,{signal:AbortSignal.timeout(10000),headers:{apikey:service,authorization:`Bearer ${service}`}}));
    const image=await validateSignatureImage(bytes);
    const recorded=await rpc(url,service,`Bearer ${service}`,"training_signature_record_file_validation",{
      p_challenge_id:challenge_id,p_detected_mime_type:image.detectedMimeType,p_actual_size_bytes:image.size,
      p_actual_width:image.width,p_actual_height:image.height,p_content_sha256:image.sha256,p_validator_version:"d15-image-validator-v1"
    });
    if(!recorded.ok)return reply(recorded.status,{reason_code:"signature_file_mismatch"});
    const fact=await recorded.json();
    return reply(200,{status:"valid",validation_id:fact.id,detected_mime_type:image.detectedMimeType,actual_size_bytes:image.size,actual_width:image.width,actual_height:image.height,content_sha256:image.sha256});
  }catch(error){
    const code=error instanceof Error&&error.message==="signature_file_invalid"?"signature_file_invalid":"signature_file_mismatch";
    return reply(400,{reason_code:code});
  }
});
