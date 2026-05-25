(function(){
var pages=[{"href": "sac-map.html", "label": "SAC Map"}, {"href": "difficulty.html", "label": "Trails & grades"}, {"href": "planning.html", "label": "Planning"}, {"href": "weather.html", "label": "Weather"}, {"href": "gear.html", "label": "Gear & safety"}];
var cur=location.pathname.split("/").pop()||"index.html";
var crumbs=document.querySelector(".crumbs");
if(!crumbs)return;
var nav=document.createElement("nav");
nav.className="guide-nav";
var parts=[];
parts.push('<a href="index.html"'+(cur==="index.html"?' class="active"':"")+">Guide</a>");
pages.forEach(function(p){
  parts.push('<a href="'+p.href+'"'+(cur===p.href?' class="active"':"")+">"+p.label+"</a>");
});
nav.innerHTML=parts.join('<span class="dot">\u00b7</span>');
crumbs.insertAdjacentElement("afterend",nav);
})();
