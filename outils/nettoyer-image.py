# Nettoie une image générée : enlève le faux damier (ou un fond uni), recadre, carré avec marge, 512 px, + aperçu en petit.
# usage : python3 -I clean.py source.png sortie.png [x0 y0 x1 y1] [taille]
import sys
from PIL import Image, ImageFilter
import numpy as np
from collections import deque
src,out=sys.argv[1],sys.argv[2]; box=tuple(map(int,sys.argv[3:7])) if len(sys.argv)>=7 else None; size=int(sys.argv[7]) if len(sys.argv)>=8 else 512
im=Image.open(src).convert('RGBA')
if box: im=im.crop(box)
a=np.array(im).astype(int); h,w,_=a.shape
rgb=a[...,:3]; mx=rgb.max(2); mn=rgb.min(2)
already=a[...,3]<20
bg=already|(((mx-mn)<24)&(mn>105))
seen=np.zeros((h,w),bool); q=deque()
for x in range(w): q.append((0,x)); q.append((h-1,x))
for y in range(h): q.append((y,0)); q.append((y,w-1))
while q:
  y,x=q.popleft()
  if y<0 or x<0 or y>=h or x>=w or seen[y,x] or not bg[y,x]: continue
  seen[y,x]=True; q.extend(((y+1,x),(y-1,x),(y,x+1),(y,x-1)))
# zones de damier enfermées (ex. trou d'une anse) : composantes « grises » qui mélangent gris moyen et blanc, comme un damier
lab=np.zeros((h,w),bool)
for y0 in range(0,h,2):
  for x0 in range(0,w,2):
    if bg[y0,x0] and not seen[y0,x0] and not lab[y0,x0]:
      comp=[]; q=deque([(y0,x0)])
      while q:
        y,x=q.popleft()
        if y<0 or x<0 or y>=h or x>=w or lab[y,x] or seen[y,x] or not bg[y,x]: continue
        lab[y,x]=True; comp.append((y,x)); q.extend(((y+1,x),(y-1,x),(y,x+1),(y,x-1)))
      if len(comp)>150:
        ys,xs=zip(*comp); v=mn[list(ys),list(xs)]
        if v.std()>14 and 125<np.median(v)<215:
          seen[list(ys),list(xs)]=True
alpha=np.minimum(a[...,3], np.where(seen,0,255)).astype('uint8')
A=Image.fromarray(alpha).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.1))
im.putalpha(A); bb=im.getbbox(); im=im.crop(bb)
s=max(im.size); pad=int(s*0.08); c=Image.new('RGBA',(s+2*pad,s+2*pad),(0,0,0,0)); c.paste(im,((c.width-im.width)//2,(c.height-im.height)//2),im)
c.resize((size,size),Image.LANCZOS).save(out)
prev=Image.new('RGBA',(560,200),(11,8,32,255)); big=c.resize((180,180),Image.LANCZOS); prev.paste(big,(10,10),big)
for i,sz in enumerate([64,32,24]): sm=c.resize((sz,sz),Image.LANCZOS); prev.paste(sm,(230+i*110,100-sz//2),sm)
prev.save(out.replace('.png','-apercu.png')); print('ok',out)
