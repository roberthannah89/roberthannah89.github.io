(function(){
var pages=[{"path": "command-center/index.html", "label": "Command center"}, {"path": "guides/planning.html", "label": "Planning"}, {"path": "guides/difficulty.html", "label": "Trails & grades"}, {"path": "guides/weather.html", "label": "Weather"}, {"path": "guides/gear.html", "label": "Gear & safety"}, {"path": "guides/sources.html", "label": "Sources"}];
function buildLinksHTML(){
  var cur=location.pathname;
  var parts=[];
  var galleryActive=/\/pages\/hikes\/(index\.html)?$/.test(cur);
  parts.push('<a href="../index.html"'+(galleryActive?' class="active"':'')+'>Hikes</a>');
  pages.forEach(function(p){
    var active=cur.indexOf('/'+p.path)>=0||cur.endsWith(p.path);
    parts.push('<a href="../'+p.path+'"'+(active?' class="active"':'')+'>'+p.label+'</a>');
  });
  return parts.join('<span class="dot">\u00b7</span>');
}
window.HikesNav={pages:pages,buildLinksHTML:buildLinksHTML};
var crumbs=document.querySelector(".crumbs");
if(!crumbs)return;
var nav=document.createElement("nav");
nav.className="guide-nav";
nav.innerHTML=buildLinksHTML();
crumbs.insertAdjacentElement("afterend",nav);
})();
