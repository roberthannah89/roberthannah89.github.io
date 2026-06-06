(function(){
var pages=[{"path": "command-center/index.html", "label": "Command center"}, {"path": "guides/planning.html", "label": "Planning"}, {"path": "guides/difficulty.html", "label": "Trails & grades"}, {"path": "guides/weather.html", "label": "Weather"}, {"path": "guides/gear.html", "label": "Gear & safety"}];
var cur=location.pathname;
var crumbs=document.querySelector(".crumbs");
if(!crumbs)return;
var nav=document.createElement("nav");
nav.className="guide-nav";
var parts=[];
parts.push('<a href="../index.html">Hikes</a>');
pages.forEach(function(p){
  var active=cur.indexOf("/"+p.path)>=0||cur.endsWith(p.path);
  parts.push('<a href="../'+p.path+'"'+(active?' class="active"':"")+">"+p.label+"</a>");
});
nav.innerHTML=parts.join('<span class="dot">\u00b7</span>');
crumbs.insertAdjacentElement("afterend",nav);
})();
