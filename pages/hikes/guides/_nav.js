(function(){
var pages=[{"href": "planning.html", "label": "Planning"}, {"href": "difficulty.html", "label": "Trails & grades"}, {"href": "weather.html", "label": "Weather"}, {"href": "gear.html", "label": "Gear & safety"}, {"href": "regions.html", "label": "Regions & cantons"}, {"href": "classics.html", "label": "50 Golden Classics"}, {"href": "resources.html", "label": "Resources"}];
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
