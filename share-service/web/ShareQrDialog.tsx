import { useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { tr } from '../renderer/i18n/core';
import logo from './assets/favicon.png?inline';

// Keep the logo and its white padding self-contained in the QR's SVG image.
const qrLogo='data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44"><rect width="44" height="44" rx="6" fill="white"/><image href="${logo}" x="6" y="6" width="32" height="32"/></svg>`);

export function ShareQrDialog({share,onClose}:{share:{id:string;title:string};onClose():void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const url=new URL('/share/'+share.id,location.origin).href;
  useEffect(()=>{
    const element=dialog.current!;
    element.showModal();
    return()=>element.close();
  },[]);
  return <dialog ref={dialog} className="share-qr-dialog" aria-label={tr('分享链接二维码')} onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
    <section className="share-qr-content">
      <h2>{share.title}</h2>
      <QRCodeSVG value={url} size={224} level="H" marginSize={4} bgColor="#ffffff" fgColor="#000000" imageSettings={{src:qrLogo,width:44,height:44,excavate:true}} role="img" title={tr('分享链接二维码')}/>
      <p>{tr('使用手机扫码打开分享')}</p>
      <button autoFocus onClick={onClose}>{tr('关闭')}</button>
    </section>
  </dialog>;
}
