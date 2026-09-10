import { PNG } from "npm:pngjs@7.0.0";
import jpeg from "npm:jpeg-js@0.4.4";
import { validateSignatureImage as validateSitePhoto } from "../../supabase/functions/d15-validate-signature/image-validation.ts";

const pixels=(width:number,height:number)=>new Uint8Array(width*height*4).fill(210);
const png=(width=96,height=96)=>PNG.sync.write({width,height,data:pixels(width,height)});
const jpg=(width=96,height=96)=>jpeg.encode({width,height,data:pixels(width,height)},80).data;
const rejects=async(bytes:Uint8Array)=>{try{await validateSitePhoto(bytes);return false;}catch{return true;}};

Deno.test("D16 real PNG bytes decode",async()=>{const r=await validateSitePhoto(png());if(r.detectedMimeType!=="image/png"||r.width!==96||r.sha256.length!==64)throw new Error("PNG decode failed");});
Deno.test("D16 real JPEG bytes decode",async()=>{const r=await validateSitePhoto(jpg());if(r.detectedMimeType!=="image/jpeg"||r.height!==96)throw new Error("JPEG decode failed");});
Deno.test("D16 text renamed as photo is rejected",async()=>{if(!await rejects(new TextEncoder().encode("not a photo")))throw new Error("text accepted");});
Deno.test("D16 SVG active content is rejected",async()=>{if(!await rejects(new TextEncoder().encode("<svg><script/></svg>")))throw new Error("SVG accepted");});
Deno.test("D16 magic-only fake PNG is rejected",async()=>{if(!await rejects(new Uint8Array([137,80,78,71,13,10,26,10])))throw new Error("fake PNG accepted");});
Deno.test("D16 actual dimensions are authoritative",async()=>{if(!await rejects(png(63,96)))throw new Error("undersized photo accepted");});
Deno.test("D16 content digest changes with bytes",async()=>{const a=await validateSitePhoto(png()),b=await validateSitePhoto(jpg());if(a.sha256===b.sha256)throw new Error("digest collision in fixture");});
