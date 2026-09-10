import { PNG } from "npm:pngjs@7.0.0";
import jpeg from "npm:jpeg-js@0.4.4";
import { validateSignatureImage } from "../../supabase/functions/d15-validate-signature/image-validation.ts";

const pixels=(width:number,height:number)=>new Uint8Array(width*height*4).fill(255);
const png=(width=80,height=40)=>PNG.sync.write({width,height,data:pixels(width,height)});
const jpg=(width=80,height=40)=>jpeg.encode({width,height,data:pixels(width,height)},80).data;
const rejects=async(bytes:Uint8Array)=>{try{await validateSignatureImage(bytes);return false;}catch{return true;}};

Deno.test("D15 valid PNG bytes decode with actual dimensions",async()=>{const r=await validateSignatureImage(png());if(r.detectedMimeType!=="image/png"||r.width!==80||r.height!==40||r.sha256.length!==64)throw new Error("PNG decode failed");});
Deno.test("D15 valid JPEG bytes decode with actual dimensions",async()=>{const r=await validateSignatureImage(jpg());if(r.detectedMimeType!=="image/jpeg"||r.width!==80||r.height!==40)throw new Error("JPEG decode failed");});
Deno.test("D15 extension and metadata cannot turn text into PNG",async()=>{if(!await rejects(new TextEncoder().encode("not an image")))throw new Error("text accepted");});
Deno.test("D15 SVG HTML and active XML are rejected",async()=>{for(const text of ["<svg><script/></svg>","<html><script/></html>","<?xml version='1.0'?><svg/>"])if(!await rejects(new TextEncoder().encode(text)))throw new Error("active content accepted");});
Deno.test("D15 mismatched extension policy follows decoded bytes",async()=>{const r=await validateSignatureImage(png());if(r.detectedMimeType!=="image/png")throw new Error("actual type not used");});
Deno.test("D15 malformed magic-only files are rejected",async()=>{if(!await rejects(new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0])))throw new Error("fake PNG accepted");if(!await rejects(new Uint8Array([255,216,255,217])))throw new Error("fake JPEG accepted");});
Deno.test("D15 actual decoded dimensions enforce limits",async()=>{if(!await rejects(png(4097,32))||!await rejects(jpg(63,32)))throw new Error("dimension limit bypassed");});
