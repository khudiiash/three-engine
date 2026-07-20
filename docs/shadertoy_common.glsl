//CONST
const float ICYCLETIME = 1./5.;
const float CYCLETIME_OFFSET = 1.;
const float I256 = 1./256.;
const float I512 = 1./512.;
const float I1024 = 1./1024.;

//DEFINE
#define RES iResolution.xy
#define IRES 1./iResolution.xy
#define ASPECT vec2(iResolution.x/iResolution.y,1.)

//STRUCT
struct HIT { float t; vec2 uv; vec2 uvo; vec2 res; vec3 n; vec3 c; };

//SDF
vec2 Rotate2(vec2 p, float ang) {
    //Rotates p *ang* radians
    float c = cos(ang);
    float s = sin(ang);
    return vec2(p.x*c - p.y*s, p.x*s + p.y*c);
}

vec2 Repeat2(vec2 p, float n) {
    //Repeats p in a PI*2/n segment
    float ang = 2.*3.141592653/n;
    float sector = floor(atan(p.x, p.y)/ang + 0.5);
    return Rotate2(p, sector*ang);
}

float DFBox(vec2 p, vec2 b) {
    //Distance field to box
    vec2 d = abs(p - b*0.5) - b*0.5;
    return min(max(d.x, d.y), 0.) + length(max(d, 0.));
}

float DFBox(vec3 p, vec3 b) {
    //Distance field to box
    vec3 d = abs(p - b*0.5) - b*0.5;
    return min(max(d.x, max(d.y, d.z)), 0.) + length(max(d, 0.));
}

//ANIMATED
vec3 GetSkyLight(vec3 d) {
    //Sky light function
    return vec3(0.7, 0.8, 1.)*(1. - d.y*0.5);
}

vec3 GetSunLight(float t) {
    //Sun light function
    float nt = CYCLETIME_OFFSET + t*ICYCLETIME;
    return vec3(1., 0.9, 0.65)*2.5;
}

vec3 GetSunDirection(float t) {
    //Sun direction function
    float nt = CYCLETIME_OFFSET + t*ICYCLETIME;
    return normalize(vec3(-sin(nt*2.4), 1., -cos(nt*2.4)));
}

bool InteriorIntersection(vec3 p) {
    //Intersection function when tracing interior wall
    if (length(p.xy - vec2(0.5, 0.)) < 0.25) return true;
    if (length(p.xy - vec2(0.87, 0.25)) < 0.12) return true;
    return false;
}

bool DFIntersection(vec3 p, float t) {
    //Intersection function when tracing geometry
    float nt = CYCLETIME_OFFSET + t*ICYCLETIME;
    
    vec3 rp = p - vec3(0.21 + (sin(nt)*0.5 + 0.5)*0.58, 0.5, 0.21 + (cos(nt)*0.5 + 0.5)*0.58);
    vec2 rep = Repeat2(rp.xz, 8.);
    float r = length(rp.xz);
    if (p.y > 0.49 && abs(p.z - 0.5) > 0.04 && r < 0.2 && abs(r - 0.1375) > 0.01 &&
        DFBox(vec2(rep.x + 0.01, rep.y - 0.015), vec2(0.02, 0.3)) > 0.) return true;
    
    return false;
}

//RT
vec3 AQuad(vec3 p, vec3 d, vec3 vTan, vec3 vBit, vec3 vNor, vec2 pSize) {
    //Analytic intersection of quad
    float norDot = dot(vNor, d);
    float pDot = dot(vNor, p);
    if (sign(norDot*pDot) < -0.5) {
        float t = -pDot/norDot;
        vec2 hit2 = vec2(dot(p + d*t, vTan), dot(p + d*t, vBit));
        if (DFBox(hit2, pSize) <= 0.) return vec3(hit2, t);
    }
    return vec3(-1.);
}

vec2 ABox(vec3 origin, vec3 dir, vec3 bmin, vec3 bmax) {
    //Analytc intersection of box
    vec3 tMin = (bmin - origin)*dir;
    vec3 tMax = (bmax - origin)*dir;
    vec3 t1 = min(tMin, tMax);
    vec3 t2 = max(tMin, tMax);
    return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
}

vec2 ABoxNormal(vec3 origin, vec3 idir, vec3 bmin, vec3 bmax, out vec3 N) {
    //Returns near/far, near normal as out
    vec3 tMin = (bmin - origin)*idir;
    vec3 tMax = (bmax - origin)*idir;
    vec3 t1 = min(tMin, tMax);
    vec3 t2 = max(tMin, tMax);
    vec3 signdir = -(max(vec3(0.), sign(idir))*2. - 1.);
    if (t1.x > max(t1.y, t1.z)) N = vec3(signdir.x, 0., 0.);
    else if (t1.y > t1.z) N = vec3(0., signdir.y, 0.);
    else N = vec3(0., 0., signdir.z);
    return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
}

float ASphere(vec3 p, vec3 d, float r) {
    //Analytic intersection of sphere
    float a = dot(p, p) - r*r;
    float b = 2.*dot(p, d);
    float re = b*b*0.25 - a;
    if (dot(p, d) < 0. && re > 0.) {
        float st = -b*0.5 - sqrt(re);
        return st;
    }
    return -1.;
}

float ACylZ(vec3 p, vec3 d, float r) {
    //Analytic intersection of cylinder along Z
    float a = (dot(p.xy, p.xy) - r*r)/dot(d.xy, d.xy);
    float b = 2.*dot(p.xy, d.xy)/dot(d.xy, d.xy);
    float re = b*b*0.25 - a;
    if (re > 0.) {
        float st = -b*0.5 + sqrt(re);
        return st;
    }
    return -1.;
}

HIT TraceRay(vec3 p, vec3 d, float maxt, float time) {
    //Ray intersection function
    HIT info = HIT(maxt, vec2(-1.), vec2(-1.), vec2(-1.), vec3(-20.), vec3(-1.));
    vec3 uvt, sp;
    vec2 bb;
    float st;
    
    //Floor
    uvt = AQuad(p, d, vec3(1., 0., 0.), vec3(0., 0., 1.), vec3(0., 1., 0.), vec2(1., 1.));
    if (uvt.z > -0.5 && uvt.z < info.t && !DFIntersection(p + d*uvt.z, time))
        info = HIT(uvt.z, uvt.xy, vec2(0., 0.), vec2(256.), vec3(0., 1., 0.), vec3(0.9));
    
    //Ceiling
    uvt = AQuad(p - vec3(0., 0.5, 0.), d, vec3(1., 0., 0.), vec3(0., 0., 1.), vec3(0., 1., 0.), vec2(1., 1.));
    if (uvt.z > -0.5 && uvt.z < info.t && !DFIntersection(p + d*uvt.z, time))
        info = HIT(uvt.z, uvt.xy, vec2(256., 0.), vec2(256.), vec3(0., -1., 0.), vec3(0.9));
    
    //Walls X 1 x 0.5
    uvt = AQuad(p, d, vec3(0., 1., 0.), vec3(0., 0., 1.), vec3(1., 0., 0.), vec2(0.5, 1.));
    if (uvt.z > -0.5 && uvt.z < info.t && !DFIntersection(p + d*uvt.z, time))
        info = HIT(uvt.z, uvt.xy, vec2(512., 0.), vec2(128., 256.), vec3(1., 0., 0.), vec3(0.9, 0.1, 0.1));
    uvt = AQuad(p - vec3(1., 0., 0.), d, vec3(0., 1., 0.), vec3(0., 0., 1.), vec3(-1., 0., 0.), vec2(0.5, 1.));
    if (uvt.z > -0.5 && uvt.z < info.t && !DFIntersection(p + d*uvt.z, time))
        info = HIT(uvt.z, uvt.xy, vec2(640., 0.), vec2(128., 256.), vec3(-1., 0., 0.), vec3(0.05, 0.95, 0.1));
    
    //Walls Z 1 x 0.5
    uvt = AQuad(p, d, vec3(0., 1., 0.), vec3(1., 0., 0.), vec3(0., 0., -1.), vec2(0.5, 1.));
    if (uvt.z > -0.5 && uvt.z < info.t && !DFIntersection(p + d*uvt.z, time))
        info = HIT(uvt.z, uvt.xy, vec2(768., 0.), vec2(128., 256.), vec3(0., 0., 1.), vec3(0.9));
    uvt = AQuad(p - vec3(0., 0., 1.), d, vec3(0., 1., 0.), vec3(1., 0., 0.), vec3(0., 0., -1.), vec2(0.5, 1.));
    if (uvt.z > -0.5 && uvt.z < info.t && !DFIntersection(p + d*uvt.z, time))
        info = HIT(uvt.z, uvt.xy, vec2(896., 0.), vec2(128., 256.), vec3(0., 0., -1.), vec3(0.9));
    
    //Interior wall
    uvt = AQuad(p - vec3(0., 0., 0.47 - 1./256.), d, vec3(0., 1., 0.), vec3(1., 0., 0.), vec3(0., 0., -1.), vec2(0.5, 1.));
    if (uvt.z > -0.5 && uvt.z < info.t && !InteriorIntersection(p + d*uvt.z))
        info = HIT(uvt.z, uvt.xy, vec2(0., 1536), vec2(128., 256.), vec3(0., 0., -1.), vec3(0.99));
    uvt = AQuad(p - vec3(0., 0., 0.53 - 1./256.), d, vec3(0., 1., 0.), vec3(1., 0., 0.), vec3(0., 0., -1.), vec2(0.5, 1.));
    if (uvt.z > -0.5 && uvt.z < info.t && !InteriorIntersection(p + d*uvt.z))
        info = HIT(uvt.z, uvt.xy, vec2(128., 1536.), vec2(128., 256.), vec3(0., 0., 1.), vec3(0.99));
    sp = p - vec3(0.5, 0., 0.);
    st = ACylZ(sp, d, 0.25);
    if (st > 0. && st < info.t && sp.z + d.z*st >= 0.47 - 1./256. && sp.z + d.z*st <= 0.53 - 1./256.)
        info = HIT(st, vec2(1.), vec2(-1.), vec2(-1.), vec3(-normalize(sp.xy + d.xy*st), 0.), vec3(0.));
    sp = p - vec3(0.87, 0.25, 0.);
    st = ACylZ(sp, d, 0.12);
    if (st > 0. && st < info.t && sp.z + d.z*st >= 0.47 - 1./256. && sp.z + d.z*st <= 0.53 - 1./256.)
        info = HIT(st, vec2(1.), vec2(-1.), vec2(-1.), vec3(-normalize(sp.xy + d.xy*st), 0.), vec3(0.));
    
    
    //Mirror sphere
    sp = p - vec3(0.15, 0.1005, 0.3);
    st = ASphere(sp, d, 0.1);
    if (st > -0.5 && st < info.t) info = HIT(st, vec2(1.), vec2(-1.), vec2(-1.), normalize(sp + d*st), vec3(-2.));
    
    //Mirror box
    vec3 sn;
    vec3 sd = d;
    sp = p - vec3(0.86, 0.14, 0.86);
    sd = normalize(sd);
    bb = ABoxNormal(sp, 1./sd, vec3(-0.08), vec3(0.08), sn);
    if (bb.x > 0. && bb.y > bb.x && bb.x < info.t) {
        info = HIT(bb.x, vec2(1.), vec2(-1.), vec2(-1.), normalize(sn), vec3(-2.));
    }
    
    return info;
}

//MATH
mat3 TBN(vec3 N) {
    //Naive TBN matrix creation
    vec3 Nb, Nt;
    if (abs(N.y) > 0.999) {
        Nb = vec3(1., 0., 0.);
        Nt = vec3(0., 0., 1.);
    } else {
    	Nb = normalize(cross(N, vec3(0., 1., 0.)));
    	Nt = normalize(cross(Nb, N));
    }
    return mat3(Nb.x, Nt.x, N.x, Nb.y, Nt.y, N.y, Nb.z, Nt.z, N.z);
}

vec3 BRDF_GGX(vec3 w_o, vec3 w_i, vec3 n, float alpha, vec3 F0) {
    //BRDF GGX
    vec3 h = normalize(w_i + w_o);
    float a2 = alpha*alpha;
    float D = a2/(3.141592653*pow(pow(dot(h, n), 2.)*(a2 - 1.) + 1., 2.));
    vec3 F = F0 + (1. - F0)*pow(1. - dot(n, w_o), 5.);
    float k = a2*0.5;
    float G = 1./((dot(n, w_i)*(1. - k)+k)*(dot(n, w_o)*(1. - k) + k));
    vec3 OUT = F*(D*G*0.25);
    return ((isnan(OUT) != bvec3(false)) ? vec3(0.) : OUT);
}