import { PNG } from "npm:pngjs@7.0.0";
import jpeg from "npm:jpeg-js@0.4.4";

export type ValidatedImage={detectedMimeType:"image/png"|"image/jpeg";size:number;width:number;height:number;sha256:string};

export async function validateSignatureImage(bytes:Uint8Array):Promise<ValidatedImage>{
  if(bytes.length<4||bytes.length>2097152)throw new Error("signature_file_invalid");
  let detectedMimeType:ValidatedImage["detectedMimeType"],width:number,height:number;
  if(bytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)){
    const decoded=PNG.sync.read(bytes,{skipRescale:true});
    detectedMimeType="image/png";width=decoded.width;height=decoded.height;
  }else if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes.at(-2)===0xff&&bytes.at(-1)===0xd9){
    const decoded=jpeg.decode(bytes,{useTArray:true,formatAsRGBA:false,tolerantDecoding:false});
    detectedMimeType="image/jpeg";width=decoded.width;height=decoded.height;
  }else throw new Error("signature_file_invalid");
  if(width<64||width>4096||height<32||height>4096)throw new Error("signature_file_invalid");
  const hash=await crypto.subtle.digest("SHA-256",bytes.slice().buffer as ArrayBuffer);
  return{detectedMimeType,size:bytes.length,width,height,sha256:[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,"0")).join("")};
}
