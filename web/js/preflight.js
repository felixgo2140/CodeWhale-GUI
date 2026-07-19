try{
  localStorage.removeItem("cw_sidebar_collapsed");
}catch(e){}
if(location.search.indexOf("compare=1")>=0) document.documentElement.classList.add("cmpwin");
