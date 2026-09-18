// Heartfelt rain equations: Martijn Steinrucken (BigWings), 2017.
// https://www.shadertoy.com/view/ltffzl
// CC BY-NC-SA 3.0, see licenses/Heartfelt-NOTICE.md.
// Adapted from the locally pinned Amado rendition, also credited under MIT.
// Changes: defined descending smooth interpolation, zero-rain branch, two-pass
// media/fluid source, bounded blur and water-like IOR mapping. This project
// later added: wind shear (u_wind), driver-driven distant lightning (u_flash),
// scene-aware mist (u_lum / u_depthMix), softened trail evaporation, and a
// separate clear-window snow pass (u_weather: 0 rain glass / 1 falling snow /
// 2 sharp scene). Snow does not use mip fog or refraction.
export const VERTEX = `#version 300 es
out vec2 v_uv;
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);v_uv=p;gl_Position=vec4(p*2.-1.,0.,1.);}`;

export const BACKGROUND = `#version 300 es
precision highp float;
in vec2 v_uv;out vec4 color;
uniform vec2 u_resolution,u_size0,u_size1;
uniform float u_time,u_mix,u_fspeed;
uniform sampler2D u_tex0,u_tex1;
uniform bool u_fluid0,u_fluid1;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);}
vec3 fluid(vec2 uv){
 vec2 p=(uv-.5)*vec2(u_resolution.x/u_resolution.y,1.);
 float t=u_time*.045*u_fspeed;
 p+=vec2(sin(p.y*2.4+t),cos(p.x*2.0-t*.7))*.34;
 float n=noise(p*2.+vec2(t*.35,-t*.2));
 float wave=sin(p.x*2.6+p.y*1.5+n*3.2+t*.4);
 float blend=smoothstep(-.7,.8,wave);
 vec3 teal=vec3(.105,.235,.218),amber=vec3(.80,.565,.335);
 return mix(teal,amber,blend)*( .91+.09*noise(p*3.+t*.1));
}
vec2 cover(vec2 uv,vec2 size){
 float screen=u_resolution.x/u_resolution.y,media=size.x/size.y;
 vec2 scale=media>screen?vec2(screen/media,1.):vec2(1.,media/screen);
 return (uv-.5)*scale+.5;
}
vec3 sampleSource(sampler2D tex,vec2 size,bool isFluid){
 if(isFluid)return fluid(v_uv);
 vec4 c=texture(tex,cover(v_uv,size));return mix(fluid(v_uv),c.rgb,c.a);
}
void main(){color=vec4(mix(sampleSource(u_tex0,u_size0,u_fluid0),sampleSource(u_tex1,u_size1,u_fluid1),smoothstep(0.,1.,u_mix)),1.);}`;

export const GLASS = `#version 300 es
precision highp float;
out vec4 color;
uniform sampler2D u_bg;
uniform vec2 u_resolution;
uniform float u_time,u_rain,u_fog,u_ior,u_wind,u_flash,u_lum,u_depthMix;
uniform float u_dropScale,u_speed,u_trail,u_bright,u_warm;
uniform float u_weather,u_snow;
float S(float a,float b,float x){if(abs(b-a)<.000001)return 0.;float t=clamp((x-a)/(b-a),0.,1.);return t*t*(3.-2.*t);}
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);}
vec3 N13(float p){
    vec3 p3=fract(vec3(p)*vec3(.1031,.11369,.13787));
    p3+=dot(p3,p3.yzx+19.19);
    return fract(vec3((p3.x+p3.y)*p3.z,(p3.x+p3.z)*p3.y,(p3.y+p3.z)*p3.x));
}
float N(float t){return fract(sin(t*12345.564)*7658.76);}
float Saw(float b,float t){return S(0.,b,t)*S(1.,b,t);}

vec2 DropLayer2(vec2 uv,float t){
    vec2 UV=uv;
    uv.y+=t*0.75;
    uv.x+=t*.42*u_wind;
    vec2 a=vec2(6.,1.);
    vec2 grid=a*2.;
    vec2 id=floor(uv*grid);
    float colShift=N(id.x);
    uv.y+=colShift;
    id=floor(uv*grid);
    vec3 n=N13(id.x*35.2+id.y*2376.1);
    vec2 st=fract(uv*grid)-vec2(.5,0.);
    float x=n.x-.5;
    float y=UV.y*20.;
    float wiggle=sin(y+sin(y));
    x+=wiggle*(.5-abs(x))*(n.z-.5);
    x*=.7;
    float ti=fract(t+n.z);
    y=(Saw(.85,ti)-.5)*.9+.5;
    vec2 p=vec2(x,y);
    float d=length((st-p)*a.yx);
    float mainDrop=S(.4,.0,d);
    float r=sqrt(S(1.,y,st.y));
    float cd=abs(st.x-x);
    float trail=S(.26*r,.12*r*r,cd);
    float trailFront=S(-.09,.05,st.y-y);
    trail*=trailFront*r*r;
    y=UV.y;
    float trail2=S(.2*r,.0,cd);
    float droplets=max(0.,(sin(y*(1.-y)*120.)-st.y))*trail2*trailFront*n.z;
    y=fract(y*10.)+(st.y-.5);
    float dd=length(st-vec2(x,y));
    droplets=S(.3,0.,dd);
    float m=mainDrop+droplets*r*trailFront;
    return vec2(m,trail);
}

float StaticDrops(vec2 uv,float t){
    uv*=40.;
    vec2 id=floor(uv);
    uv=fract(uv)-.5;
    vec3 n=N13(id.x*107.45+id.y*3543.654);
    vec2 p=(n.xy-.5)*.7;
    float d=length(uv-p);
    float fade=Saw(.025,fract(t+n.z));
    float c=S(.3,0.,d)*fract(n.z*10.)*fade;
    return c;
}

vec2 Drops(vec2 uv,float t,float l0,float l1,float l2){
    float s=StaticDrops(uv,t)*l0;
    vec2 m1=DropLayer2(uv,t)*l1;
    vec2 m2=DropLayer2(uv*1.85,t)*l2;
    float c=s+m1.x+m2.x;
    c=S(.3,1.,c);
    return vec2(c,max(m1.y*l0,m2.y*l1));
}

// Clear-window snow. Landscape stays sharp (no mip fog / refraction).
// Motion: Stokes-like mass (small flakes follow wind, large ones fall faster),
// hexagonal plates tumble (apparent squash + facet glint), gust field from fbm,
// independent terminal velocity with birth/death fade so wraps don't pop.
float fbm(vec2 p){
 float a=0.,b=.5;
 for(int i=0;i<3;i++){a+=b*noise(p);p=p*2.07+vec2(17.2,9.1);b*=.51;}
 return a;
}
float SnowDust(vec2 uv,float t,float scale,float speed,float sizeMul,vec2 wind){
 uv.x-=t*wind.x*.5;
 uv.y+=t*speed*u_speed;
 uv.x+=sin(uv.y*2.8+t*.65)*.028*(.2+u_wind);
 vec2 id=floor(uv*scale);
 vec2 gv=fract(uv*scale)-.5;
 vec3 n=N13(id.x*13.1+id.y*47.9+scale);
 float spawn=S(mix(.7,.16,u_snow),.8,n.z);
 vec2 p=(n.xy-.5)*.72;
 p.x+=sin(t*mix(1.4,2.8,n.z)+n.x*6.28)*.06;
 float d=length(gv-p);
 float sz=mix(.04,.1,n.x)*sizeMul*u_dropScale;
 return (S(sz,0.,d)+S(sz*2.2,0.,d)*.14)*spawn;
}
float SnowFlakes(vec2 uv,float t,float scale,float speed,float sizeMul,vec2 wind,float nearness){
 uv.x-=t*wind.x*mix(.45,1.15,nearness);
 vec2 gid=floor(uv*scale);
 vec2 gv=fract(uv*scale)-.5;
 float acc=0.;
 for(int j=-1;j<=1;j++)
 for(int i=-1;i<=1;i++){
  vec2 cell=gid+vec2(float(i),float(j));
  vec3 n=N13(cell.x*17.23+cell.y*91.7+scale*3.1);
  float mass=mix(.58,1.28,n.x);
  float fall=mix(.7,1.24,n.x)*speed*u_speed/mass;
  float ty=fract(n.z+t*fall);
  float fade=S(0.,.07,ty)*S(1.,.93,ty);
  float amp=mix(.05,.17,n.y)*mix(.65,1.2,nearness);
  float freq=mix(1.05,3.05,n.z);
  float phase=n.x*6.2831853;
  vec2 pos=vec2((n.x-.5)*.5,.5-ty);
  pos.x+=sin(t*freq+phase)*amp;
  pos.x+=sin(t*freq*.37+phase*1.7)*amp*.52;
  pos.y+=sin(t*freq*.58+phase*.6)*amp*.26;
  pos.x+=wind.x*(1.15-mass)*.14;
  pos+=vec2(float(i),float(j));
  vec2 q=gv-pos;
  float tumble=.5+.5*sin(t*mix(.75,2.5,n.x)+phase);
  float squash=mix(.4,1.,tumble);
  float ang=t*mix(.35,1.7,n.y)+phase;
  float ca=cos(ang),sa=sin(ang);
  q=vec2(ca*q.x-sa*q.y,(sa*q.x+ca*q.y)/squash);
  float r=length(q);
  float a=atan(q.y,q.x);
  float sz=mix(.032,.078,n.x)*sizeMul*u_dropScale*mix(.88,1.12,nearness);
  float hex=abs(cos(a*3.));
  float arms=pow(hex,6.);
  float barb=pow(abs(cos(a*6.+n.z*4.)),10.)*.26;
  float core=S(sz,0.,r);
  float plate=S(sz*1.42,0.,r)*.3;
  float star=S(sz*mix(1.65,2.4,tumble),0.,r)*(arms*.72+barb);
  float glow=S(sz*2.25,0.,r)*.1;
  float glint=pow(max(tumble,0.),6.)*pow(hex,12.)*core*.7;
  float flake=(core+plate+star*mix(.22,1.,tumble)+glow+glint)*mix(.52,1.,tumble);
  acc+=flake*fade*S(mix(.55,.12,u_snow),.7,n.z);
 }
 return acc;
}
vec3 applySnow(vec3 c){
 vec2 uv=(gl_FragCoord.xy-.5*u_resolution)/u_resolution.y;
 float t=u_time*.2;
 float gust=fbm(vec2(uv.y*.65-t*.07,t*.04));
 float eddy=noise(uv*2.1+vec2(t*.19,-t*.08));
 float alt=S(-.65,.82,uv.y);
 vec2 wind=vec2(u_wind*(.5+.85*gust)*(.72+.5*alt),(gust-.5)*.07*u_wind+(eddy-.5)*.05);
 float s=0.;
 s+=SnowDust(uv,t,40.,.16,.48,wind)*.26;
 s+=SnowDust(uv,t,24.,.28,.62,wind)*.36;
 s+=SnowDust(uv,t,13.,.46,.82,wind)*.46;
 s+=SnowFlakes(uv,t,5.6,.82,.9,wind,.7)*.72;
 s+=SnowFlakes(uv,t,3.25,1.08,1.02,wind,1.)*.55;
 float vol=S(.74,.97,noise(uv*vec2(86.,112.)+vec2(t*.18*u_wind,-t*1.08)));
 vol+=S(.78,.99,noise(uv*vec2(46.,68.)+vec2(-t*.11,-t*.52)))*.55;
 float streaks=S(.68,.94,noise(vec2(uv.x*52.-t*wind.x*7.,uv.y*13.+t*1.15)));
 s+=vol*.14+streaks*.07;
 s*=mix(.65,1.,u_snow);
 float alpha=1.-exp(-s*1.28);
 alpha=clamp(alpha,0.,.9);
 vec3 flake=mix(vec3(.94,.97,1.),vec3(1.),mix(.25,.8,1.-u_lum));
 float k=mix(1.08,.68,u_lum);
 c=c*(1.-alpha*.2)+flake*alpha*k;
 return c;
}

vec3 rainGlass(vec2 UV){
 vec2 uv=(gl_FragCoord.xy-.5*u_resolution)/u_resolution.y;
 float t=u_time*.17*u_speed;
 vec2 drops=vec2(0.);vec2 normal=vec2(0.);
 if(u_rain>.001){
  float still=S(0.,1.,u_rain)*1.8;
  float slow=S(.12,.8,u_rain);
  float small=S(.05,.65,u_rain);
  vec2 duv=uv*u_dropScale;
  drops=Drops(duv,t,still,slow,small);
  vec2 e=vec2(.001,0.);
  normal=vec2(Drops(duv+e,t,still,slow,small).x-drops.x,Drops(duv+e.yx,t,still,slow,small).x-drops.x);
 }
 // Water height gradient bends the view; streaks wipe condensation from glass.
 normal*=clamp((u_ior-1.)/.33,0.,2.)*.85;
 drops.y=clamp(drops.y*u_trail,0.,1.6);
 // 雨-场景联动雾感：画面上部视为远景（雾更重），水汽随时间缓慢漂移，
 // 雨越大雾越厚，亮场景雾感更明显；u_depthMix=0 时退回全屏均匀雾。
 float fogBase=u_fog*5.5;
 float depth=S(.1,1.05,UV.y);
 float drift=noise(UV*vec2(2.3,1.5)+vec2(u_time*.016,-u_time*.011));
 float density=mix(fogBase,
     fogBase*(.4+.9*depth)*(.78+.5*drift)*(.72+.55*u_rain)*(.7+.5*u_lum),
     u_depthMix);
 float wiped=max(S(.08,.65,drops.x),clamp(drops.y,0.,1.));
 float focus=mix(density,0.,wiped);
 vec2 refracted=clamp(UV+normal,vec2(.002),vec2(.998));
 vec3 c=textureLod(u_bg,refracted,focus).rgb;
 // 远处闪电：照亮整个场景，亮面受光更多；包络由驱动层控制，短暂即逝。
 float luma=dot(c,vec3(.299,.587,.114));
 c+=u_flash*vec3(.34,.38,.47)*(.55+.45*luma);
 // Subtle meniscus highlight; bright scenes make wet glass sparkle more.
 c+=vec3(.032,.035,.029)*clamp((normal.x-normal.y)*7.,-.3,1.)*u_rain*(.6+.8*u_lum);
 return c;
}

void main(){
 vec2 UV=gl_FragCoord.xy/u_resolution;
 vec3 c;
 if(u_weather>.5){
  // 雪景 / 晴空：普通采样，风景保持清晰，不走 mip 雾。
  c=texture(u_bg,UV).rgb;
  if(u_weather<1.5&&u_snow>.001)c=applySnow(c);
 }else{
  c=rainGlass(UV);
 }
 c=c*u_bright+u_warm*vec3(.07,.024,-.05);
 color=vec4(clamp(c,0.,1.),1.);
}`;
