import { useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { tr } from '../renderer/i18n/core';

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
      <QRCodeSVG value={url} size={224} level="M" marginSize={4} bgColor="#ffffff" fgColor="#000000" role="img" title={tr('分享链接二维码')}/>
      <p>{tr('使用手机扫码打开分享')}</p>
      <button autoFocus onClick={onClose}>{tr('关闭')}</button>
    </section>
  </dialog>;
}
