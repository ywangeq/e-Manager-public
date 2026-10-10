// Equal endpoints mean all day; other windows use local device time, end exclusive.
export function allowedTime(timestamp,start,end) {
  const date=new Date(timestamp),minute=date.getHours()*60+date.getMinutes();
  if(start===end || (start<end ? minute>=start&&minute<end : minute>=start||minute<end))return timestamp;
  if(minute>=start)date.setDate(date.getDate()+1);
  date.setHours(Math.floor(start/60),start%60,0,0);return date.getTime();
}
