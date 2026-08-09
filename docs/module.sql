
with q_module as(
-- select proper moddule 
select 
mdv.ModuleVID
from Framework f
join Concept cpt on cpt.ConceptGUID = f.RowGUID
join DPMClass cls on cls.ClassID = cpt.ClassID
join Organisation org on org.OrgID = f.OwnerID
join Module mod on mod.FrameworkID = f.FrameworkID
join ModuleVersion mdv on mdv.ModuleID = mod.ModuleID 
where f.Code = 'PAY' and mdv.Code = 'PSD_FRP'
and mdv.ToReferenceDate is Null)

select 
--var.Type,
mvc.Order TableOrder,
tv.TableVID,
tv.Code TableCode,
tv.Description TableDescription
-- tv.*
from ModuleVersionComposition mvc
join q_module qm on qm.ModuleVID = mvc.ModuleVID
join TableVersion tv on tv.TableVID = mvc.TableVID
